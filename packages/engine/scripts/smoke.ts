/**
 * Smoke probe — step 3 (hard gate) of the engine-port plan.
 *
 * Boots the engine with stub plugins, binds Hono to an OS-assigned port
 * (port 0), drives a single-task workflow to executionStatus=completed
 * entirely through real HTTP I/O, then tears everything down.
 *
 * The probe issues transition-task commands directly rather than spawning
 * a real provider subprocess. That is intentional: the orchestrator/provider
 * path is already covered by the 827-test suite. The gate value here is
 * "HTTP server boots in this monorepo and processes requests end-to-end."
 *
 * Exit 0 on pass, exit 1 on any failure.
 */

import { createAdaptorServer } from "@hono/node-server";
import { unlink } from "node:fs/promises";
import { createEngine } from "../src/engine.js";
import { StubProviderPlugin } from "../src/plugins/providers/stub.js";
import { StubWorkspaceBackend } from "../src/plugins/workspace/stub-workspace.js";
import { StubQualityPlugin } from "../src/plugins/quality/stub-quality-plugin.js";
import type { Workflow } from "../src/domain/types.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk, RuntimeStartResult, RuntimeStartSpec } from "../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../src/application/recovery.js";

const DB_PATH = "/tmp/engine-port-smoke.db";

const WORKFLOW_ID = "smoke-wf-1";
const TASK_ID = "smoke-task-1";

function makeFinalRuntime(): RuntimeBackend {
  let counter = 0;
  return {
    async start(_spec: RuntimeStartSpec): Promise<RuntimeStartResult> {
      return { sessionId: `smoke-session-${++counter}`, runtimeType: "stub" };
    },
    async stop(): Promise<void> {},
    async probe(): Promise<RuntimeProbeState> { return "live"; },
    attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
      return {
        [Symbol.asyncIterator]: async function* () {
          // Yield one line so parseFrame fires and the stub plugin returns the final event
          const bytes = new TextEncoder().encode("final-line\n");
          yield { sessionId: _sessionId, offset: 0, bytes };
        },
      };
    },
  };
}

function makeClient(baseUrl: string) {
  async function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json();
    return { status: res.status, data };
  }

  async function get(path: string): Promise<{ status: number; data: unknown }> {
    const res = await fetch(`${baseUrl}${path}`);
    const data: unknown = await res.json();
    return { status: res.status, data };
  }

  return { post, get };
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
  }
}

async function pollUntilCompleted(
  client: ReturnType<typeof makeClient>,
  timeoutMs = 10_000,
): Promise<Workflow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, data } = await client.get(`/workflows/${WORKFLOW_ID}`);
    if (status !== 200) throw new Error(`GET /workflows/${WORKFLOW_ID} returned ${status}`);
    const wf = data as Workflow;
    const task = wf.graph[TASK_ID];
    if (!task) throw new Error(`task ${TASK_ID} not found in workflow graph`);
    const execStatus = task.executionStatus;
    console.log(`  poll: task executionStatus=${execStatus}`);
    if (execStatus === "completed" || execStatus === "merged" || execStatus === "pr-open") return wf;
    if (execStatus === "failed" || execStatus === "cancelled" || execStatus === "needs-review") {
      throw new Error(`task reached terminal non-success status: ${execStatus}`);
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for task to complete`);
}

async function main(): Promise<void> {
  const startMs = Date.now();
  console.log("=== SMOKE START ===");
  console.log(`db: ${DB_PATH}`);

  const finalEvent = { kind: "final" as const, sessionRef: "smoke-ref" };
  const engine = await createEngine({
    dbPath: DB_PATH,
    providerFactory: () => new StubProviderPlugin({ frames: [[finalEvent]] }),
    runtime: makeFinalRuntime(),
    workspace: new StubWorkspaceBackend(),
    qualityPlugin: new StubQualityPlugin(),
    logLevel: "warn",
  });

  console.log("engine created");

  // Bind on port 0 so the OS assigns a free ephemeral port — no collisions.
  const httpServer = createAdaptorServer({ fetch: engine.server.fetch });
  const actualPort = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("could not determine bound port"));
        return;
      }
      resolve(addr.port);
    });
  });

  const baseUrl = `http://127.0.0.1:${actualPort}`;
  console.log(`HTTP server bound to ${baseUrl}`);
  const client = makeClient(baseUrl);

  try {
    // 1. Create workflow
    const createBody = {
      id: WORKFLOW_ID,
      kind: "single-task",
      tasks: [
        {
          id: TASK_ID,
          title: "Smoke test task",
          prompt: "do something",
        },
      ],
    };
    const createResult = await client.post("/workflows", createBody);
    assertStatus("POST /workflows", createResult.status, 201);
    const createdWf = createResult.data as Workflow;
    console.log(`workflow created: id=${createdWf.id}`);

    // SchedulerService auto-dispatches the task — no manual transitions needed.
    // Poll GET /workflows/:id until executionStatus=completed
    const pollStart = Date.now();
    const finalWf = await pollUntilCompleted(client);
    const pollMs = Date.now() - pollStart;

    const finalTask = finalWf.graph[TASK_ID]!;
    const successStatuses = new Set(["completed", "merged", "pr-open"]);
    if (!successStatuses.has(finalTask.executionStatus)) {
      throw new Error(
        `expected a success executionStatus, got=${finalTask.executionStatus}`,
      );
    }

    const totalMs = Date.now() - startMs;
    console.log(`task reached 'completed' in ~${pollMs}ms poll time`);
    console.log(`total probe duration: ${totalMs}ms`);
    console.log(`workflow.status: ${finalWf.status}`);
    console.log(`task.executionStatus: ${finalTask.executionStatus}`);
  } finally {
    httpServer.close();
    await engine.close();
    try {
      await unlink(DB_PATH);
    } catch {
      // file may not exist if engine failed to init
    }
    console.log("cleanup done");
  }

  console.log("=== SMOKE PASS ===");
}

main().catch((err: unknown) => {
  console.error("SMOKE FAIL:", (err as Error).message ?? err);
  process.exit(1);
});
