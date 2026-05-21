import { createAdaptorServer } from "@hono/node-server";
import { makeHarness, type PipelineHarness } from "../test/fixtures/pipeline-harness.js";
import { FakeSCM } from "../test/fixtures/fake-scm.js";
import { FakeGitHubClient, asGitHubClient } from "../test/fixtures/fake-github-client.js";
import { StubProviderPlugin } from "../src/plugins/providers/stub.js";
import { slugify } from "../src/plugins/workspace-backend.js";
import type { Workflow, TaskExecutionStatus } from "../src/domain/types.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk, RuntimeStartResult, RuntimeStartSpec } from "../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../src/application/recovery.js";
import type { GhCheckRun, GhPRDetail, GitHubClient } from "../src/plugins/github/github-client.js";

const FAST_CADENCE = {
  intervals: [{ afterMs: 0, everyMs: 10 }],
  maxHorizonMs: 10_000,
  noChecksBailMs: 500,
  confirmationDelayMs: 10,
};

interface SmokeClient {
  post(path: string, body?: unknown): Promise<{ status: number; data: unknown }>;
  get(path: string): Promise<{ status: number; data: unknown }>;
}

function makeFinalRuntime(): RuntimeBackend {
  let counter = 0;
  return {
    async start(_spec: RuntimeStartSpec): Promise<RuntimeStartResult> {
      return { sessionId: `smoke-session-${++counter}`, runtimeType: "stub" };
    },
    async stop(): Promise<void> {},
    async probe(): Promise<RuntimeProbeState> {
      return "live";
    },
    attach(sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
      return {
        [Symbol.asyncIterator]: async function* () {
          const bytes = new TextEncoder().encode("final-line\n");
          yield { sessionId, offset: 0, bytes };
        },
      };
    },
  };
}

function makeProvider(): StubProviderPlugin {
  return new StubProviderPlugin({ frames: [[{ kind: "final", sessionRef: `smoke-ref-${Date.now()}` }]] });
}

function makeClient(baseUrl: string): SmokeClient {
  async function parse(res: Response): Promise<{ status: number; data: unknown }> {
    const contentType = res.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? await res.json() as unknown : await res.text();
    return { status: res.status, data };
  }

  return {
    async post(path, body) {
      const init: RequestInit = { method: "POST" };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      return parse(await fetch(`${baseUrl}${path}`, init));
    },
    async get(path) {
      return parse(await fetch(`${baseUrl}${path}`));
    },
  };
}

async function bindHarness(harness: PipelineHarness): Promise<{ client: SmokeClient; close: () => Promise<void> }> {
  const httpServer = createAdaptorServer({ fetch: harness.engine.server.fetch });
  const port = await new Promise<number>((resolve, reject) => {
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

  return {
    client: makeClient(`http://127.0.0.1:${port}`),
    close: () => new Promise((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

async function withBoundHarness(
  harness: PipelineHarness,
  run: (client: SmokeClient) => Promise<void>,
): Promise<void> {
  const bound = await bindHarness(harness);
  try {
    await run(bound.client);
  } finally {
    await bound.close();
    await harness.cleanup();
  }
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${label}: expected HTTP ${expected}, got ${actual}`);
}

function branchName(workflowId: string, taskId: string): string {
  return `minions/${slugify(workflowId)}_${slugify(taskId)}`;
}

async function createWorkflow(
  client: SmokeClient,
  input: {
    id: string;
    taskId: string;
    policy?: Record<string, unknown>;
  },
): Promise<void> {
  const res = await client.post("/workflows", {
    id: input.id,
    kind: "single-task",
    repoId: "fixture-repo",
    tasks: [{ id: input.taskId, title: `Smoke ${input.taskId}`, prompt: "exercise the smoke matrix" }],
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
  });
  assertStatus(`POST /workflows ${input.id}`, res.status, 201);
}

async function getWorkflow(client: SmokeClient, workflowId: string): Promise<Workflow> {
  const res = await client.get(`/workflows/${workflowId}`);
  assertStatus(`GET /workflows/${workflowId}`, res.status, 200);
  return res.data as Workflow;
}

async function waitForTaskStatus(
  client: SmokeClient,
  workflowId: string,
  taskId: string,
  allowed: readonly TaskExecutionStatus[],
  timeoutMs = 10_000,
): Promise<Workflow> {
  const deadline = Date.now() + timeoutMs;
  const expected = new Set<TaskExecutionStatus>(allowed);
  while (Date.now() < deadline) {
    const wf = await getWorkflow(client, workflowId);
    const status = wf.graph[taskId]?.executionStatus;
    console.log(`  ${workflowId}: ${status ?? "missing"}`);
    if (status !== undefined && expected.has(status)) return wf;
    if (status === "failed" || status === "cancelled") {
      throw new Error(`${workflowId}: task reached ${status}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${workflowId}: timed out waiting for ${allowed.join(" or ")}`);
}

function dynamicRepairGithub(repoRef: { current: PipelineHarness["engine"]["repo"] | undefined }): GitHubClient {
  const detail = async (): Promise<GhPRDetail> => {
    const wf = await repoRef.current?.get("smoke-ci-repair");
    const task = wf?.graph["task-ci-repair"];
    const hasReport = task?.artifacts.some((artifact) => artifact.kind === "ci-report") ?? false;
    const headSha = hasReport ? "head-fixed" : "head-failed";
    return {
      number: 1,
      url: "https://fake.local/fake/fake/pull/1",
      headSha,
      headRef: branchName("smoke-ci-repair", "task-ci-repair"),
      baseRef: "main",
      mergeable: true,
      mergeableState: "clean",
      state: "open",
      merged: false,
    };
  };

  return {
    getPR: async () => detail(),
    listCheckRuns: async (_owner, _repo, headSha) => {
      const conclusion = headSha === "head-fixed" ? "success" : "failure";
      return [{ name: "ci", status: "completed", conclusion } satisfies GhCheckRun];
    },
    findPRByHead: async () => null,
    createPR: async () => ({ number: 1, url: "https://fake.local/fake/fake/pull/1", headRef: branchName("smoke-ci-repair", "task-ci-repair"), baseRef: "main" }),
    mergePR: async () => ({ merged: true, sha: "merged" }),
  } as unknown as GitHubClient;
}

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  console.log(`=== SMOKE CASE START: ${name} ===`);
  await fn();
  console.log(`=== SMOKE CASE PASS: ${name} (${Date.now() - start}ms) ===`);
}

async function autoMergeGreen(): Promise<void> {
  const scm = new FakeSCM();
  const githubClient = new FakeGitHubClient(scm);
  const harness = await makeHarness({
    withRealQuality: true,
    qualityCommand: "pass",
    scm,
    githubClient: asGitHubClient(githubClient),
    ciBabysitterCadence: FAST_CADENCE,
    providerFactory: makeProvider,
    runtime: makeFinalRuntime(),
  });
  await withBoundHarness(harness, async (client) => {
    await createWorkflow(client, {
      id: "smoke-auto-merge",
      taskId: "task-auto-merge",
      policy: { autoLand: true, autoMergeOnGreen: true },
    });
    await waitForTaskStatus(client, "smoke-auto-merge", "task-auto-merge", ["pr-open", "ci-pending"]);
    const pr = scm.getPRForBranch(branchName("smoke-auto-merge", "task-auto-merge"));
    if (!pr) throw new Error("auto-merge PR was not created");
    scm.setCheckRuns(pr.headSha, [{ name: "ci", status: "completed", conclusion: "success" }]);
    await waitForTaskStatus(client, "smoke-auto-merge", "task-auto-merge", ["merged"]);
  });
}

async function ciRepairThenMerge(): Promise<void> {
  const scm = new FakeSCM();
  const repoRef: { current: PipelineHarness["engine"]["repo"] | undefined } = { current: undefined };
  const harness = await makeHarness({
    withRealQuality: true,
    qualityCommand: "pass",
    scm,
    githubClient: dynamicRepairGithub(repoRef),
    ciBabysitterCadence: FAST_CADENCE,
    providerFactory: makeProvider,
    runtime: makeFinalRuntime(),
  });
  repoRef.current = harness.engine.repo;
  await withBoundHarness(harness, async (client) => {
    await createWorkflow(client, {
      id: "smoke-ci-repair",
      taskId: "task-ci-repair",
      policy: { autoLand: true, autoMergeOnGreen: true },
    });
    await waitForTaskStatus(client, "smoke-ci-repair", "task-ci-repair", ["merged"], 15_000);
    const wf = await getWorkflow(client, "smoke-ci-repair");
    const ciReports = wf.graph["task-ci-repair"]?.artifacts.filter((artifact) => artifact.kind === "ci-report") ?? [];
    if (ciReports.length === 0) throw new Error("ci-repair path did not record a CI report");
  });
}

async function qualityBlocks(): Promise<void> {
  const harness = await makeHarness({
    withRealQuality: true,
    qualityCommand: "fail",
    providerFactory: makeProvider,
    runtime: makeFinalRuntime(),
  });
  await withBoundHarness(harness, async (client) => {
    await createWorkflow(client, {
      id: "smoke-quality-block",
      taskId: "task-quality-block",
      policy: { autoLand: true, autoMergeOnGreen: true },
    });
    await waitForTaskStatus(client, "smoke-quality-block", "task-quality-block", ["needs-review"]);
  });
}

async function manualMerge(): Promise<void> {
  const scm = new FakeSCM();
  const harness = await makeHarness({
    withRealQuality: true,
    qualityCommand: "pass",
    scm,
    githubClient: asGitHubClient(new FakeGitHubClient(scm)),
    ciBabysitterCadence: FAST_CADENCE,
    providerFactory: makeProvider,
    runtime: makeFinalRuntime(),
  });
  await withBoundHarness(harness, async (client) => {
    await createWorkflow(client, {
      id: "smoke-manual-merge",
      taskId: "task-manual-merge",
      policy: { autoLand: true, autoMergeOnGreen: false },
    });
    await waitForTaskStatus(client, "smoke-manual-merge", "task-manual-merge", ["pr-open", "ci-pending"]);
    const pr = scm.getPRForBranch(branchName("smoke-manual-merge", "task-manual-merge"));
    if (!pr) throw new Error("manual-merge PR was not created");
    scm.setCheckRuns(pr.headSha, [{ name: "ci", status: "completed", conclusion: "success" }]);
    await waitForTaskStatus(client, "smoke-manual-merge", "task-manual-merge", ["pr-open"]);
    const res = await client.post("/workflows/smoke-manual-merge/tasks/task-manual-merge/merge");
    assertStatus("POST manual merge", res.status, 200);
    await waitForTaskStatus(client, "smoke-manual-merge", "task-manual-merge", ["merged"]);
  });
}

async function mergeConflict(): Promise<void> {
  const scm = new FakeSCM({ rebaseBehaviour: "conflict" });
  const harness = await makeHarness({
    withRealQuality: true,
    qualityCommand: "pass",
    scm,
    githubClient: asGitHubClient(new FakeGitHubClient(scm)),
    providerFactory: makeProvider,
    runtime: makeFinalRuntime(),
  });
  await withBoundHarness(harness, async (client) => {
    await createWorkflow(client, {
      id: "smoke-conflict",
      taskId: "task-conflict",
      policy: { autoLand: true, autoMergeOnGreen: false },
    });
    await waitForTaskStatus(client, "smoke-conflict", "task-conflict", ["needs-review"]);
  });
}

async function completeWithoutPr(): Promise<void> {
  const harness = await makeHarness({
    withRealQuality: true,
    qualityCommand: "pass",
    providerFactory: makeProvider,
    runtime: makeFinalRuntime(),
  });
  await withBoundHarness(harness, async (client) => {
    await createWorkflow(client, {
      id: "smoke-complete-without-pr",
      taskId: "task-complete-without-pr",
      policy: { autoLand: false, autoMergeOnGreen: false },
    });
    await waitForTaskStatus(client, "smoke-complete-without-pr", "task-complete-without-pr", ["merged"]);
  });
}

async function main(): Promise<void> {
  const start = Date.now();
  console.log("=== SMOKE MATRIX START ===");
  await runCase("auto-merge green", autoMergeGreen);
  await runCase("ci fail then repair then merge", ciRepairThenMerge);
  await runCase("quality blocks", qualityBlocks);
  await runCase("manual merge", manualMerge);
  await runCase("merge conflict", mergeConflict);
  await runCase("complete without PR", completeWithoutPr);
  console.log(`=== SMOKE MATRIX PASS (${Date.now() - start}ms) ===`);
}

main().catch((err: unknown) => {
  console.error("SMOKE MATRIX FAIL:", (err as Error).message ?? err);
  process.exit(1);
});
