import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import type { Engine, EngineConfig } from "../src/engine.js";
import { silentLogger } from "./test-helpers.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk, RuntimeStartResult, RuntimeStartSpec } from "../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../src/application/recovery.js";
import { SQLiteWorkflowRepository } from "../src/persistence/sqlite-repo.js";
import { applyCommand } from "../src/application/commands.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";
import { StubProviderPlugin } from "../src/plugins/providers/stub.js";
import { StubRuntimeBackend } from "../src/plugins/stub-runtime.js";

function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  return join(dir, "test.db");
}

describe("createEngine", () => {
  let engine: Engine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempPath();
  });

  afterEach(async () => {
    await engine?.close();
  });

  it("creates engine with SQLite repo and stub runtime", async () => {
    engine = await createEngine({ dbPath, log: silentLogger() });
    expect(engine.server).toBeDefined();
  });

  it("close() releases the DB without throwing", async () => {
    engine = await createEngine({ dbPath, log: silentLogger() });
    await expect(engine.close()).resolves.toBeUndefined();
  });

  it("rebuild sees workflows saved in a prior instance", async () => {
    const now = "2026-05-04T11:19:00.000Z";
    const spec = {
      id: "wf-engine-1",
      kind: "single-task" as const,
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
    };

    const first = await createEngine({ dbPath, now: () => now, log: silentLogger() });
    const req = new Request("http://localhost/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    const res = await first.server.fetch(req);
    expect(res.status).toBe(201);
    await first.close();

    const second = await createEngine({ dbPath, now: () => now, log: silentLogger() });
    const getReq = new Request("http://localhost/workflows/wf-engine-1");
    const getRes = await second.server.fetch(getReq);
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { id: string };
    expect(body.id).toBe("wf-engine-1");
    engine = second;
  });
});

describe("createEngine — close() aborts boot-spawned orchestrators", () => {
  it("close() aborts in-flight orchestrators before closing the repo", async () => {
    const dbPath = makeTempPath();
    const now = "2026-05-04T11:19:00.000Z";

    // Seed a live running task directly into the DB so boot recovery spawns an orchestrator
    const seedRepo = new SQLiteWorkflowRepository(dbPath);
    const wf = createSingleTaskWorkflow("wf-close-1", { title: "T", prompt: "P" }, () => now);
    await seedRepo.save(wf, []);
    await applyCommand(seedRepo, {
      kind: "transition-task",
      workflowId: "wf-close-1",
      transition: { kind: "mark-ready", taskId: "wf-close-1:task", now },
    });
    await applyCommand(seedRepo, {
      kind: "transition-task",
      workflowId: "wf-close-1",
      transition: { kind: "mark-running", taskId: "wf-close-1:task", sessionId: "live-sess", now },
    });
    seedRepo.close();

    let capturedSignal: AbortSignal | undefined;
    const runtime: RuntimeBackend = {
      async start(_spec: RuntimeStartSpec): Promise<RuntimeStartResult> {
        return { sessionId: "live-sess", runtimeType: "stub" };
      },
      async stop(): Promise<void> {},
      async probe(): Promise<RuntimeProbeState> {
        return "live";
      },
      attach(_sessionId: string, opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
        capturedSignal = opts?.signal;
        return {
          [Symbol.asyncIterator]: async function* () {
            // Hang until aborted
            await new Promise<void>((_resolve, reject) => {
              opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
          },
        };
      },
    };

    const config: EngineConfig = {
      dbPath,
      runtime,
      now: () => now,
      providerFactory: () => new StubProviderPlugin({ frames: [] }),
      log: silentLogger(),
    };

    const eng = await createEngine(config);

    // Give the orchestrator a tick to reach runtime.attach
    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await eng.close();

    expect(capturedSignal?.aborted).toBe(true);

    // Task must remain `running` — not transitioned to `needs-review` — so next boot can re-spawn.
    const postCloseRepo = new SQLiteWorkflowRepository(dbPath);
    const postCloseWf = await postCloseRepo.get("wf-close-1");
    postCloseRepo.close();
    const task = postCloseWf?.graph["wf-close-1:task"];
    expect(task?.executionStatus).toBe("running");
  });
});

describe("createEngine — close() aborts service-spawned orchestrators", () => {
  it("close() aborts orchestrators spawned by continue-task or retry-task via the server", async () => {
    const dbPath = makeTempPath();
    const now = "2026-05-06T10:00:00.000Z";

    // Seed a needs-review task so continue-task can proceed
    const seedRepo = new SQLiteWorkflowRepository(dbPath);
    const wf = createSingleTaskWorkflow("wf-svc-1", { title: "T", prompt: "P" }, () => now);
    await seedRepo.save(wf, []);
    await applyCommand(seedRepo, {
      kind: "transition-task",
      workflowId: "wf-svc-1",
      transition: { kind: "mark-ready", taskId: "wf-svc-1:task", now },
    });
    await applyCommand(seedRepo, {
      kind: "transition-task",
      workflowId: "wf-svc-1",
      transition: { kind: "mark-running", taskId: "wf-svc-1:task", sessionId: "s-seed", now },
    });
    await applyCommand(seedRepo, {
      kind: "transition-task",
      workflowId: "wf-svc-1",
      transition: { kind: "mark-interrupted", taskId: "wf-svc-1:task", now },
    });
    // Patch providerSessionRef so continue-task finds a resumable session
    const wfCurrent = await seedRepo.get("wf-svc-1");
    const seedTask = wfCurrent!.graph["wf-svc-1:task"]!;
    const patchedRun = { ...seedTask.runs[0]!, providerSessionRef: "prior-ref" };
    await seedRepo.save({
      ...wfCurrent!,
      version: wfCurrent!.version + 1,
      graph: { "wf-svc-1:task": { ...seedTask, runs: [patchedRun] } },
    }, []);
    seedRepo.close();

    let capturedSignal: AbortSignal | undefined;
    const stubRuntime = new StubRuntimeBackend();
    const origAttach = stubRuntime.attach.bind(stubRuntime);
    stubRuntime.attach = (_sessionId: string, opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> => {
      capturedSignal = opts?.signal;
      return {
        [Symbol.asyncIterator]: async function* () {
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        },
      };
    };
    void origAttach; // suppress unused warning

    const config: EngineConfig = {
      dbPath,
      runtime: stubRuntime,
      now: () => now,
      providerFactory: () => new StubProviderPlugin({ frames: [] }),
      log: silentLogger(),
    };

    const eng = await createEngine(config);

    // Dispatch continue-task via the HTTP server
    const req = new Request("http://localhost/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "continue-task",
        workflowId: "wf-svc-1",
        taskId: "wf-svc-1:task",
        prompt: "continue please",
      }),
    });
    const res = await eng.server.fetch(req);
    expect(res.status).toBe(200);

    // Give orchestrator a tick to reach runtime.attach
    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await eng.close();

    expect(capturedSignal?.aborted).toBe(true);
  });
});
