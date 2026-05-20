import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBootstrapClone, createEngine } from "../src/engine.js";
import type { Engine, EngineConfig } from "../src/engine.js";
import { silentLogger } from "./test-helpers.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk, RuntimeStartResult, RuntimeStartSpec } from "../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../src/application/recovery.js";
import { SQLiteWorkflowRepository } from "../src/persistence/sqlite-repo.js";
import { applyCommand } from "../src/application/commands.js";
import { createSingleTaskWorkflow } from "../src/domain/workflow.js";
import { StubProviderPlugin } from "../src/plugins/providers/stub.js";
import { StubRuntimeBackend } from "../src/plugins/stub-runtime.js";
import { StubWorkspaceBackend } from "../src/plugins/workspace/stub-workspace.js";

async function waitForTaskStatus(
  engine: Engine,
  workflowId: string,
  taskId: string,
  status: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workflow = await engine.repo.get(workflowId);
    if (workflow?.graph[taskId]?.executionStatus === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const workflow = await engine.repo.get(workflowId);
  throw new Error(`Timed out waiting for ${taskId} to reach ${status}; actual=${workflow?.graph[taskId]?.executionStatus ?? "missing"}`);
}

function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  return join(dir, "test.db");
}

describe("buildBootstrapClone", () => {
  it("keeps github remotes clean and moves auth into askpass env", () => {
    const result = buildBootstrapClone("https://github.com/openai/example.git", "ghp-secret");
    expect(result.remote).toBe("https://github.com/openai/example.git");
    expect(result.env).toEqual(expect.objectContaining({
      GH_TOKEN: "ghp-secret",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: expect.stringContaining("gh-askpass.sh"),
    }));
  });

  it("does not attach auth env for non-github remotes", () => {
    const result = buildBootstrapClone("https://gitlab.example.com/group/repo.git", "ghp-secret");
    expect(result).toEqual({ remote: "https://gitlab.example.com/group/repo.git" });
  });
});

class FinalFrameRuntime extends StubRuntimeBackend {
  attach(sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { sessionId, offset: 0, bytes: new TextEncoder().encode("final\n") };
      },
    };
  }
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
    engine = await createEngine({ dbPath, repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }], log: silentLogger() });
    expect(engine.server).toBeDefined();
  });

  it("close() releases the DB without throwing", async () => {
    engine = await createEngine({ dbPath, repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }], log: silentLogger() });
    await expect(engine.close()).resolves.toBeUndefined();
  });

  it("GET /version exposes pi in providers list", async () => {
    engine = await createEngine({ dbPath, repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }], log: silentLogger() });
    const res = await engine.server.fetch(new Request("http://localhost/version"));
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: string[] };
    expect(body.providers).toContain("pi");
    expect(body.providers).toContain("claude-code");
    expect(body.providers).toContain("codex");
  });

  it("rebuild sees workflows saved in a prior instance", async () => {
    const now = "2026-05-04T11:19:00.000Z";
    const spec = {
      id: "wf-engine-1",
      kind: "single-task" as const,
      repoId: "fixture-repo",
      tasks: [{ id: "t1", title: "T", prompt: "P" }],
    };

    const first = await createEngine({ dbPath, repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }], now: () => now, log: silentLogger() });
    const req = new Request("http://localhost/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    const res = await first.server.fetch(req);
    expect(res.status).toBe(201);
    await first.close();

    const second = await createEngine({ dbPath, repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }], now: () => now, log: silentLogger() });
    const getReq = new Request("http://localhost/workflows/wf-engine-1");
    const getRes = await second.server.fetch(getReq);
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as { id: string };
    expect(body.id).toBe("wf-engine-1");
    engine = second;
  });

  it("uses a no-op quality gate by default so completed tasks can finalize", async () => {
    engine = await createEngine({
      dbPath,
      repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }],
      providerFactory: () => new StubProviderPlugin({ frames: [[{ kind: "final", sessionRef: "session-ref" }]] }),
      runtime: new FinalFrameRuntime(),
      workspace: new StubWorkspaceBackend(),
      now: () => "2026-05-04T11:19:00.000Z",
      log: silentLogger(),
    });

    const res = await engine.server.fetch(new Request("http://localhost/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "wf-default-quality",
        kind: "single-task",
        repoId: "fixture-repo",
        tasks: [{ id: "task", title: "T", prompt: "P" }],
      }),
    }));
    expect(res.status).toBe(201);

    await waitForTaskStatus(engine, "wf-default-quality", "task", "merged");
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
            yield* [];
          },
        };
      },
    };

    const config: EngineConfig = {
      dbPath,
      repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }],
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
          yield* [];
        },
      };
    };
    void origAttach; // suppress unused warning

    const config: EngineConfig = {
      dbPath,
      repos: [{ id: "fixture-repo", label: "fixture-repo", localPath: "/tmp/fake-repo" }],
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
        taskId: "wf-svc-1:task", repoId: "fixture-repo",
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
