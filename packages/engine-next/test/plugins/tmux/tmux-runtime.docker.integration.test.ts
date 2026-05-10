// Run with MWF_HAS_DOCKER=1 npm test to exercise these. They're skipped by default.
// Requires: `docker compose up -d minions-worker` and host bind at /var/lib/minions/sessions.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxRuntimeBackend } from "../../../src/plugins/tmux/tmux-runtime.js";
import { planRecovery } from "../../../src/application/recovery.js";
import type { Workflow } from "../../../src/domain/types.js";

const execAsync = promisify(exec);

const HOST_SESSIONS_DIR = process.env["MWF_DOCKER_HOST_DATA_DIR"] ?? "/var/lib/minions";
const WORKER_SESSIONS_DIR = process.env["MWF_DOCKER_WORKER_SESSIONS_DIR"] ?? "/sessions";
const CONTAINER = process.env["MWF_DOCKER_CONTAINER"] ?? "minions-worker";

describe.skipIf(process.env["MWF_HAS_DOCKER"] !== "1")("TmuxRuntimeBackend docker integration", () => {
  let backend: TmuxRuntimeBackend;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mwf-docker-"));
    backend = new TmuxRuntimeBackend({
      dataDir: HOST_SESSIONS_DIR,
      workerSessionsDir: WORKER_SESSIONS_DIR,
      commandPrefix: ["docker", "exec", CONTAINER],
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full lifecycle: start → probe live → attach → stop → probe missing", async () => {
    const { sessionId } = await backend.start({
      taskId: "docker-lifecycle",
      workflowId: "wf-docker",
      command: ["sh", "-c", "echo hello-docker; sleep 10"],
    });

    expect(await backend.probe(sessionId)).toBe("live");

    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    setTimeout(() => controller.abort(), 500);

    for await (const chunk of backend.attach(sessionId, { fromOffset: 0, signal: controller.signal })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("hello-docker");

    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  }, 15000);

  it("PRIMARY: attach receives final output and terminates without abort", async () => {
    const { sessionId } = await backend.start({
      taskId: "docker-primary",
      workflowId: "wf-docker",
      command: ["sh", "-c", "printf tail-line; exit 0"],
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of backend.attach(sessionId, { fromOffset: 0 })) {
      chunks.push(chunk.bytes);
    }

    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("tail-line");
    expect(await backend.probe(sessionId)).toBe("dead");
  }, 15000);

  it("stop racing in-flight attach does not lose final bytes", async () => {
    const { sessionId } = await backend.start({
      taskId: "docker-race-stop",
      workflowId: "wf-docker",
      command: ["sh", "-c", "printf done-docker; sleep 30"],
    });

    const chunks: Uint8Array[] = [];
    const attachPromise = (async () => {
      for await (const chunk of backend.attach(sessionId, { fromOffset: 0 })) {
        chunks.push(chunk.bytes);
      }
    })();

    await new Promise((r) => setTimeout(r, 200));
    await backend.stop(sessionId);
    await attachPromise;

    expect(await backend.probe(sessionId)).toBe("missing");
    const output = Buffer.concat(chunks.map((b) => Buffer.from(b))).toString();
    expect(output).toContain("done-docker");
  }, 15000);

  it("restart drill: docker stop → probe missing → recovery rules emit recover-task", async () => {
    const { sessionId } = await backend.start({
      taskId: "docker-restart-drill",
      workflowId: "wf-docker",
      command: ["sh", "-c", "sleep 60"],
    });

    expect(await backend.probe(sessionId)).toBe("live");

    await execAsync(`docker stop ${CONTAINER}`);
    await new Promise((r) => setTimeout(r, 2000));

    const probeState = await backend.probe(sessionId);
    expect(probeState).toBe("missing");

    const now = Date.now();
    const fakeWorkflow: Workflow = {
      id: "wf-docker",
      kind: "single-task",
      status: "active",
      graph: {
        "docker-restart-drill": {
          id: "docker-restart-drill",
          workflowId: "wf-docker",
          title: "drill",
          prompt: "",
          dependsOn: [],
          executionStatus: "running",
          stackStatus: "clean",
          priority: 0,
          claims: [],
          contract: { summary: "", expectedArtifacts: [] },
          artifacts: [],
          sessionId,
          runs: [],
          readiness: "ready",
          version: 1,
          createdAt: new Date(now - 5000).toISOString(),
          updatedAt: new Date(now - 5000).toISOString(),
        },
      },
      operations: {},
      policy: { maxConcurrent: 1, autoLand: false, autoMergeOnGreen: false },
      version: 1,
      createdAt: new Date(now - 5000).toISOString(),
      updatedAt: new Date(now - 5000).toISOString(),
    };

    const actions = planRecovery(fakeWorkflow, {
      nowMs: now,
      staleReadyMs: 30000,
      staleGateMs: 30000,
      runtimeProbes: { [sessionId]: probeState },
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("recover-task");
    expect(actions[0]?.reason).toContain("missing");

    await execAsync(`docker start ${CONTAINER}`);
    await new Promise((r) => setTimeout(r, 1000));
  }, 30000);

  it("start throws when container is stopped", async () => {
    await execAsync(`docker stop ${CONTAINER}`).catch(() => {});

    await expect(
      backend.start({
        taskId: "docker-stopped-start",
        workflowId: "wf-docker",
        command: ["sh", "-c", "echo hi"],
      }),
    ).rejects.toThrow();

    await execAsync(`docker start ${CONTAINER}`);
    await new Promise((r) => setTimeout(r, 1000));
  }, 30000);
});
