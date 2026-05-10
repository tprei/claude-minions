import { describe, expect, it, vi } from "vitest";
import { CompletionDispatcher } from "../../src/application/completion-dispatcher.js";
import { silentLogger } from "../test-helpers.js";
import { MergeAbortedError, MergeConflictError, MergeServiceError } from "../../src/application/merge-service.js";
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import type { CommandResult } from "../../src/application/commands.js";
import type { MergeService } from "../../src/application/merge-service.js";

const NOW = "2026-05-07T10:00:00.000Z";
const now = () => NOW;
const WORKFLOW_ID = "wf-1";
const TASK_ID = "wf-1:task";

function makeRepo() {
  return new InMemoryWorkflowRepository();
}

function makeMergeService(overrides: Partial<MergeService> = {}): MergeService {
  return {
    openOnly: vi.fn().mockResolvedValue({ workflow: null, events: [] } as unknown as CommandResult),
    merge: vi.fn().mockResolvedValue({ workflow: null, events: [] } as unknown as CommandResult),
    ...overrides,
  } as unknown as MergeService;
}

async function makeWorkflowInFinalizing(repo: InMemoryWorkflowRepository, autoLand = false) {
  const wf = createWorkflow({
    id: WORKFLOW_ID,
    kind: "single-task",
    tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    policy: { maxConcurrent: 1, autoLand, autoMergeOnGreen: false },
  }, now);
  await repo.save(wf, []);
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
  });
}

function makeService(
  repo: InMemoryWorkflowRepository,
  mergeService: MergeService,
  signal: AbortSignal,
) {
  return new CompletionDispatcher({
    workflowRepo: repo,
    applyCommand: (cmd) => applyCommand(repo, cmd),
    mergeService,
    signal,
    now,
    log: silentLogger(),
  });
}

describe("CompletionDispatcher", () => {
  it("attach is idempotent", async () => {
    const repo = makeRepo();
    const mergeService = makeMergeService();
    const ctrl = new AbortController();
    const wf = createWorkflow({
      id: WORKFLOW_ID,
      kind: "single-task",
      tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    }, now);
    await repo.save(wf, []);

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);
    service.attach(WORKFLOW_ID);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setImmediate(r));
    ctrl.abort();

    expect(mergeService.openOnly).not.toHaveBeenCalled();
  });

  it("task in finalizing + autoLand:false → no-op", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, false);
    const mergeService = makeMergeService();
    const ctrl = new AbortController();

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    expect(mergeService.openOnly).not.toHaveBeenCalled();
  });

  it("task in finalizing + autoLand:true → calls openOnly", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);
    const mergeService = makeMergeService();
    const ctrl = new AbortController();

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    expect(mergeService.openOnly).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_ID, taskId: TASK_ID }));
  });

  it("task in finalizing + autoLand:true + MergeConflictError → no-op (handled by MergeService)", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);
    const mergeService = makeMergeService({
      openOnly: vi.fn().mockRejectedValue(new MergeConflictError("rebase_conflict", "conflict")),
    });
    const ctrl = new AbortController();

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    expect(mergeService.openOnly).toHaveBeenCalledOnce();
  });

  it("task in finalizing + autoLand:true + MergeServiceError → log + bail", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);
    const mergeServiceErr = new MergeServiceError("merge_state_inconsistent", {});
    const mergeService = makeMergeService({
      openOnly: vi.fn().mockRejectedValue(mergeServiceErr),
    });
    const ctrl = new AbortController();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    consoleSpy.mockRestore();

    expect(mergeService.openOnly).toHaveBeenCalledOnce();
  });

  it("task in finalizing + autoLand:true + unknown error → log + bail", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);
    const mergeService = makeMergeService({
      openOnly: vi.fn().mockRejectedValue(new Error("unexpected")),
    });
    const ctrl = new AbortController();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    consoleSpy.mockRestore();

    expect(mergeService.openOnly).toHaveBeenCalledOnce();
  });

  it("attach scans existing finalizing tasks at attach time", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);
    const mergeService = makeMergeService();
    const ctrl = new AbortController();

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    expect(mergeService.openOnly).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_ID, taskId: TASK_ID }));
  });

  it("transition into finalizing via event triggers dispatch", async () => {
    const repo = makeRepo();
    const wf = createWorkflow({
      id: WORKFLOW_ID,
      kind: "single-task",
      tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
      policy: { maxConcurrent: 1, autoLand: true, autoMergeOnGreen: false },
    }, now);
    await repo.save(wf, []);

    const mergeService = makeMergeService();
    const ctrl = new AbortController();

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setImmediate(r));

    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
    });

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    expect(mergeService.openOnly).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_ID, taskId: TASK_ID }));
  });

  it("engine signal cascade aborts all", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);

    let resolveOpenOnly: () => void;
    const mergeService = makeMergeService({
      openOnly: vi.fn().mockReturnValue(new Promise<CommandResult>((resolve) => {
        resolveOpenOnly = () => resolve({ workflow: null, events: [] } as unknown as CommandResult);
      })),
    });
    const ctrl = new AbortController();

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    resolveOpenOnly!();
    await new Promise((r) => setImmediate(r));
  });

  it("detach aborts in-flight task controllers", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);

    let resolveOpenOnly: () => void;
    const mergeService = makeMergeService({
      openOnly: vi.fn().mockReturnValue(new Promise<CommandResult>((resolve) => {
        resolveOpenOnly = () => resolve({ workflow: null, events: [] } as unknown as CommandResult);
      })),
    });
    const ctrl = new AbortController();

    const service = makeService(repo, mergeService, ctrl.signal);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    service.detach(WORKFLOW_ID);
    resolveOpenOnly!();
    ctrl.abort();

    await new Promise((r) => setImmediate(r));
  });

  it("MED3: CompletionDispatcher abort propagates to in-flight openOnly → MergeAbortedError caught, no merge-conflict", async () => {
    const repo = makeRepo();
    await makeWorkflowInFinalizing(repo, true);

    let capturedSignal: AbortSignal | undefined;
    const mergeService = makeMergeService({
      openOnly: vi.fn().mockImplementation(async (opts: { workflowId: string; taskId: string; signal?: AbortSignal }) => {
        capturedSignal = opts.signal;
        return new Promise<CommandResult>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new MergeAbortedError()), { once: true });
        });
      }),
    });
    const ctrl = new AbortController();
    const applyCommandSpy = vi.fn((cmd: Parameters<typeof applyCommand>[1]) => applyCommand(repo, cmd));

    const service = new CompletionDispatcher({
      workflowRepo: repo,
      applyCommand: applyCommandSpy,
      mergeService,
      signal: ctrl.signal,
      now,
      log: silentLogger(),
    });
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedSignal).toBeDefined();
    const mergeConflictCalls = applyCommandSpy.mock.calls.filter(
      (c) => c[0].kind === "transition-task" && "transition" in c[0] && (c[0] as { transition: { kind: string } }).transition.kind === "merge-conflict",
    );
    expect(mergeConflictCalls).toHaveLength(0);
  });
});
