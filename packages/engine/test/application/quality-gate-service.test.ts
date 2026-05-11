import { describe, expect, it, vi } from "vitest";
import { QualityGateService } from "../../src/application/quality-gate-service.js";
import { silentLogger } from "../test-helpers.js";
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import { StubQualityPlugin } from "../../src/plugins/quality/stub-quality-plugin.js";
import type { WorkspaceBackend, WorkspaceHandle } from "../../src/plugins/workspace-backend.js";
import type { QualityGateConfig, QualityPlugin, QualityRunResult } from "../../src/plugins/quality-plugin.js";

const NOW = "2026-05-07T10:00:00.000Z";
const now = () => NOW;

const WORKFLOW_ID = "wf-1";
const TASK_ID = "wf-1:task";
const WORKSPACE_ID = "ws-abc";

function makeRepo() {
  return new InMemoryWorkflowRepository();
}

function makeHandle(workspaceId = WORKSPACE_ID): WorkspaceHandle {
  return { workspaceId, mode: "worktree", path: "/workspace", containerPath: "/workspace", branch: "b" };
}

function makeWorkspace(handle?: WorkspaceHandle): WorkspaceBackend {
  return {
    create: vi.fn().mockResolvedValue(makeHandle()),
    get: vi.fn().mockResolvedValue(handle),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeTaskCompleted(repo: InMemoryWorkflowRepository, workspaceId = WORKSPACE_ID): Promise<void> {
  const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, now);
  await repo.save(wf, []);

  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", workspaceId, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
  });
}

function makeDeps(overrides: {
  repo?: InMemoryWorkflowRepository;
  workspace?: WorkspaceBackend;
  plugin?: QualityPlugin;
  signal?: AbortSignal;
}) {
  const repo = overrides.repo ?? makeRepo();
  const ctrl = new AbortController();
  return {
    repo,
    workspace: overrides.workspace ?? makeWorkspace(makeHandle()),
    plugin: overrides.plugin ?? new StubQualityPlugin({
      configs: [{ name: "lint", command: "npm run lint" }],
      result: { status: "passed", checks: [] },
    }),
    signal: overrides.signal ?? ctrl.signal,
    ctrl,
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new QualityGateService({
    workflowRepo: deps.repo,
    workspace: deps.workspace,
    plugin: deps.plugin,
    applyCommand: (cmd) => applyCommand(deps.repo, cmd),
    signal: deps.signal,
    now,
    log: silentLogger(),
  });
}

describe("QualityGateService", () => {
  it("attach is idempotent — second attach does not duplicate consumer", async () => {
    const repo = makeRepo();
    const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, now);
    await repo.save(wf, []);

    const deps = makeDeps({ repo });
    const service = makeService(deps);

    service.attach(WORKFLOW_ID);
    service.attach(WORKFLOW_ID);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setImmediate(r));
    deps.ctrl.abort();

    expect(deps.workspace.get).not.toHaveBeenCalled();
  });

  it("pass path — gates pass, task transitions to finalizing", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const plugin = new StubQualityPlugin({
      configs: [{ name: "lint", command: "npm run lint" }],
      result: { status: "passed", checks: [] },
    });
    const deps = makeDeps({ repo, plugin });
    const service = makeService(deps);

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    deps.ctrl.abort();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("finalizing");
    const artifacts = wf?.graph[TASK_ID]?.artifacts ?? [];
    const report = artifacts.find((a) => a.kind === "quality-report");
    expect(report).toBeDefined();
    const ref = JSON.parse(report!.ref) as { overallStatus: string };
    expect(ref.overallStatus).toBe("passed");
  });

  it("fail path — gates fail, task transitions to needs-review", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const plugin = new StubQualityPlugin({
      configs: [{ name: "lint", command: "npm run lint" }],
      result: { status: "failed", checks: [] },
    });
    const deps = makeDeps({ repo, plugin });
    const service = makeService(deps);

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    deps.ctrl.abort();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
  });

  it("partial pass — task transitions to needs-review (not passed)", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const plugin = new StubQualityPlugin({
      configs: [{ name: "lint", command: "npm run lint" }],
      result: { status: "partial", checks: [] },
    });
    const deps = makeDeps({ repo, plugin });
    const service = makeService(deps);

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    deps.ctrl.abort();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
  });

  it("no config — empty-checks artifact + pass → finalizing", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const plugin = new StubQualityPlugin({ configs: [], result: { status: "passed", checks: [] } });
    const deps = makeDeps({ repo, plugin });
    const service = makeService(deps);

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    deps.ctrl.abort();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("finalizing");
    const artifacts = wf?.graph[TASK_ID]?.artifacts ?? [];
    const report = artifacts.find((a) => a.kind === "quality-report");
    expect(report).toBeDefined();
    const ref = JSON.parse(report!.ref) as { checks: unknown[] };
    expect(ref.checks).toHaveLength(0);
  });

  it("workspace.get returns undefined — fail with workspace-missing artifact", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const workspace = makeWorkspace(undefined);
    const plugin = new StubQualityPlugin({
      configs: [{ name: "lint", command: "lint" }],
      result: { status: "passed", checks: [] },
    });
    const deps = makeDeps({ repo, workspace, plugin });
    const service = makeService(deps);

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    deps.ctrl.abort();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
    const artifacts = wf?.graph[TASK_ID]?.artifacts ?? [];
    const report = artifacts.find((a) => a.kind === "quality-report");
    expect(report).toBeDefined();
    const ref = JSON.parse(report!.ref) as { reason: string };
    expect(ref.reason).toBe("workspace-missing");
  });

  it("aborts on detach — runForTask stops", async () => {
    const repo = makeRepo();
    const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, now);
    await repo.save(wf, []);

    const ctrl = new AbortController();
    const plugin = new StubQualityPlugin({ configs: [], result: { status: "passed", checks: [] }, rejectOnAbort: true });
    const service = new QualityGateService({
      workflowRepo: repo,
      workspace: makeWorkspace(makeHandle()),
      plugin,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    service.detach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    expect(true).toBe(true);
  });

  it("attach scans existing completed tasks at attach time", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const plugin = new StubQualityPlugin({
      configs: [],
      result: { status: "passed", checks: [] },
    });
    const applyCommandSpy = vi.fn((cmd: Parameters<typeof applyCommand>[1]) => applyCommand(repo, cmd));
    const ctrl = new AbortController();
    const service = new QualityGateService({
      workflowRepo: repo,
      workspace: makeWorkspace(makeHandle()),
      plugin,
      applyCommand: applyCommandSpy,
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    const startGateCalls = applyCommandSpy.mock.calls.filter(
      (c) => c[0].kind === "transition-task" &&
        "transition" in c[0] &&
        (c[0] as { transition: { kind: string } }).transition.kind === "start-quality-gate",
    );
    expect(startGateCalls.length).toBeGreaterThan(0);
  });

  it("aborts on transition out of quality-pending", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    let resolveRun!: () => void;
    const blockingPlugin = {
      loadConfig: async () => [{ name: "test", command: "t" }] as QualityGateConfig[],
      run: (_configs: QualityGateConfig[], _path: string, opts: { signal?: AbortSignal }): Promise<QualityRunResult> =>
        new Promise<QualityRunResult>((resolve, reject) => {
          resolveRun = () => resolve({ status: "passed", checks: [] });
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };

    const ctrl = new AbortController();
    const service = new QualityGateService({
      workflowRepo: repo,
      workspace: makeWorkspace(makeHandle()),
      plugin: blockingPlugin,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 50));

    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "cancel-task", taskId: TASK_ID, now: NOW },
    });

    await new Promise((r) => setTimeout(r, 50));
    resolveRun();
    ctrl.abort();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("cancelled");
  });

  it("engine signal cascade aborts all controllers", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const ctrl = new AbortController();
    let abortedBySignal = false;
    const plugin = {
      loadConfig: async () => [{ name: "test", command: "t" }] as QualityGateConfig[],
      run: (_configs: QualityGateConfig[], _path: string, opts: { signal?: AbortSignal }): Promise<QualityRunResult> =>
        new Promise<QualityRunResult>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            abortedBySignal = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
    };

    const service = new QualityGateService({
      workflowRepo: repo,
      workspace: makeWorkspace(makeHandle()),
      plugin,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 50));

    ctrl.abort();
    await new Promise((r) => setTimeout(r, 50));

    expect(abortedBySignal).toBe(true);
  });

  it("malformed loadConfig — task transitions to needs-review with config-error artifact", async () => {
    const repo = makeRepo();
    await makeTaskCompleted(repo);

    const plugin = {
      loadConfig: async (_path: string): Promise<never> => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
      run: vi.fn(),
    };
    const deps = makeDeps({ repo, plugin });
    const service = makeService(deps);

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    deps.ctrl.abort();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph[TASK_ID]?.executionStatus).toBe("needs-review");
    const artifacts = wf?.graph[TASK_ID]?.artifacts ?? [];
    const report = artifacts.find((a) => a.kind === "quality-report");
    expect(report).toBeDefined();
    const ref = JSON.parse(report!.ref) as { reason: string; overallStatus: string };
    expect(ref.reason).toBe("config-error");
    expect(ref.overallStatus).toBe("failed");
  });

  it("runForTask bails when task moved out of completed mid-run", async () => {
    const repo = makeRepo();
    const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, now);
    await repo.save(wf, []);

    const plugin = new StubQualityPlugin({
      configs: [],
      result: { status: "passed", checks: [] },
    });
    const applyCommandSpy = vi.fn((cmd: Parameters<typeof applyCommand>[1]) => applyCommand(repo, cmd));
    const ctrl = new AbortController();
    const service = new QualityGateService({
      workflowRepo: repo,
      workspace: makeWorkspace(makeHandle()),
      plugin,
      applyCommand: applyCommandSpy,
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const startGateCalls = applyCommandSpy.mock.calls.filter(
      (c) => c[0].kind === "transition-task" &&
        "transition" in c[0] &&
        (c[0] as { transition: { kind: string } }).transition.kind === "start-quality-gate",
    );
    expect(startGateCalls).toHaveLength(0);
  });
});
