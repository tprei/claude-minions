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
import { StubRuntimeBackend } from "../src/plugins/stub-runtime.js";
import { StubWorkspaceBackend } from "../src/plugins/workspace/stub-workspace.js";
import { StubQualityPlugin } from "../src/plugins/quality/stub-quality-plugin.js";
import type { Workflow } from "../src/domain/types.js";

const DB_PATH = "/tmp/engine-port-smoke.db";

const WORKFLOW_ID = "smoke-wf-1";
const TASK_ID = "smoke-task-1";
const STUB_SESSION_ID = "smoke-session-stub";

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
    if (execStatus === "completed") return wf;
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

  const engine = await createEngine({
    dbPath: DB_PATH,
    providerFactory: () => new StubProviderPlugin({ frames: [] }),
    runtime: new StubRuntimeBackend(),
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

    // 2. Transition: pending → ready
    const t0 = new Date().toISOString();
    const readyResult = await client.post("/commands", {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "mark-ready", taskId: TASK_ID, now: t0 },
    });
    assertStatus("mark-ready", readyResult.status, 200);
    console.log("  transition: pending → ready");

    // 3. Transition: ready → running (supply a stub sessionId)
    const t1 = new Date().toISOString();
    const runningResult = await client.post("/commands", {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: {
        kind: "mark-running",
        taskId: TASK_ID,
        sessionId: STUB_SESSION_ID,
        now: t1,
      },
    });
    assertStatus("mark-running", runningResult.status, 200);
    console.log("  transition: ready → running");

    // 4. Transition: running → completed via complete-runtime
    const t2 = new Date().toISOString();
    const completeResult = await client.post("/commands", {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: {
        kind: "complete-runtime",
        taskId: TASK_ID,
        expectedSessionId: STUB_SESSION_ID,
        now: t2,
      },
    });
    assertStatus("complete-runtime", completeResult.status, 200);
    console.log("  transition: running → completed");

    // 5. Poll GET /workflows/:id until executionStatus=completed
    const pollStart = Date.now();
    const finalWf = await pollUntilCompleted(client);
    const pollMs = Date.now() - pollStart;

    const finalTask = finalWf.graph[TASK_ID]!;
    if (finalTask.executionStatus !== "completed") {
      throw new Error(
        `expected executionStatus=completed, got=${finalTask.executionStatus}`,
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
