import { describe, expect, it, vi } from "vitest";
import { ContinueTaskService } from "../../src/application/continue-task-service.js";
import { applyCommand } from "../../src/application/commands.js";
import type { CommandResult } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { DomainError } from "../../src/domain/errors.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import { getOpenRun } from "../../src/domain/runs.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";
import type { NodeRun } from "../../src/domain/runs.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";

const now = "2026-05-04T11:19:00.000Z";

async function makeNeedsReviewTask(repo: InMemoryWorkflowRepository, providerSessionRef: string) {
  const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
  await repo.save(wf, []);

  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: "wf-1",
    transition: { kind: "mark-ready", taskId: "wf-1:task", now },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: "wf-1",
    transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: "wf-1",
    transition: { kind: "mark-interrupted", taskId: "wf-1:task", now },
  });

  const wfCurrent = await repo.get("wf-1");
  const task = wfCurrent!.graph["wf-1:task"]!;
  const patchedRun: NodeRun = { ...task.runs[0]!, providerSessionRef };
  const patchedWf = {
    ...wfCurrent!,
    version: wfCurrent!.version + 1,
    graph: { "wf-1:task": { ...task, runs: [patchedRun] } },
  };
  await repo.save(patchedWf, []);
}

describe("ContinueTaskService", () => {
  it("happy path: needs-review task with prior providerSessionRef → running, attempt 2, run carries sessionRef", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const resumeSpy = vi.spyOn(provider, "resume");

    await makeNeedsReviewTask(repo, "prior-session-ref");

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    const result = await service.run({
      workflowId: "wf-1",
      taskId: "wf-1:task",
      prompt: "please continue",
    });

    expect(resumeSpy).toHaveBeenCalledOnce();
    expect(resumeSpy).toHaveBeenCalledWith({
      sessionRef: "prior-session-ref",
      prompt: "please continue",
      taskId: "wf-1:task",
      workflowId: "wf-1",
    });

    const task = result.workflow.graph["wf-1:task"]!;
    expect(task.executionStatus).toBe("running");
    expect(task.runs).toHaveLength(2);
    expect(task.runs[1]?.attempt).toBe(2);
    expect(task.runs[1]?.providerSessionRef).toBe("prior-session-ref");
  });

  it("sad path: no closed run with providerSessionRef → throws invalid_transition, no provider.resume call", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const resumeSpy = vi.spyOn(provider, "resume");

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-running", taskId: "wf-1:task", sessionId: "s1", now },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-interrupted", taskId: "wf-1:task", now },
    });

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    let caughtErr: unknown;
    try {
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("sad path: task in ready with prior providerSessionRef → throws invalid_transition, no provider.resume or runtime.start call", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const resumeSpy = vi.spyOn(provider, "resume");
    const startSpy = vi.spyOn(runtime, "start");

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });

    const wfCurrent = await repo.get("wf-1");
    const task = wfCurrent!.graph["wf-1:task"]!;
    const patchedRun: NodeRun = { ...task.runs[0]!, endedAt: now, providerSessionRef: "prior-ref" };
    const patchedWf = {
      ...wfCurrent!,
      version: wfCurrent!.version + 1,
      graph: { "wf-1:task": { ...task, runs: [patchedRun] } },
    };
    await repo.save(patchedWf, []);

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    let caughtErr: unknown;
    try {
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect((caughtErr as DomainError).message).toContain("ready");
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("sad path: task stackStatus is restack-pending → throws invalid_transition, no provider.resume call", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const resumeSpy = vi.spyOn(provider, "resume");

    await makeNeedsReviewTask(repo, "prior-ref");

    const wfCurrent = await repo.get("wf-1");
    const task = wfCurrent!.graph["wf-1:task"]!;
    const patchedWf = {
      ...wfCurrent!,
      version: wfCurrent!.version + 1,
      graph: { "wf-1:task": { ...task, stackStatus: "restack-pending" as const } },
    };
    await repo.save(patchedWf, []);

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    let caughtErr: unknown;
    try {
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect((caughtErr as DomainError).message).toContain("restack-pending");
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("race window: stackStatus flips to restack-pending between preflight and mark-running → mark-running rejects, runtime.stop called", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo, "prior-session-ref");

    let getCallCount = 0;
    const originalGet = repo.get.bind(repo);
    vi.spyOn(repo, "get").mockImplementation(async (workflowId: string) => {
      getCallCount++;
      const wf = await originalGet(workflowId);
      if (getCallCount === 2 && wf) {
        const task = wf.graph["wf-1:task"]!;
        return {
          ...wf,
          graph: { "wf-1:task": { ...task, stackStatus: "restack-pending" as const } },
        };
      }
      return wf;
    });

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    let caughtErr: unknown;
    try {
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it("sad path: provider.resume rejects → error propagates, task stays in needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    vi.spyOn(provider, "resume").mockRejectedValue(new Error("provider unavailable"));

    await makeNeedsReviewTask(repo, "existing-ref");

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" }),
    ).rejects.toThrow("provider unavailable");

    const wfAfter = await repo.get("wf-1");
    expect(wfAfter!.graph["wf-1:task"]!.executionStatus).toBe("needs-review");
  });

  it("sad path: runtime.start rejects → error propagates, task stays in needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    vi.spyOn(runtime, "start").mockRejectedValue(new Error("runtime unavailable"));
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo, "existing-ref");

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" }),
    ).rejects.toThrow("runtime unavailable");

    const wfAfter = await repo.get("wf-1");
    expect(wfAfter!.graph["wf-1:task"]!.executionStatus).toBe("needs-review");
  });

  it("spawnOrchestrator called once with expected deps shape", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo, "prior-session-ref");

    const spawnOrchestrator = vi.fn();
    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator,
    });

    await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" });

    const wfPost = await repo.get("wf-1");
    const taskPost = wfPost?.graph["wf-1:task"];
    const openRun = taskPost ? getOpenRun(taskPost.runs) : undefined;

    expect(spawnOrchestrator).toHaveBeenCalledOnce();
    const spawnedDeps = spawnOrchestrator.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnedDeps.workflowId).toBe("wf-1");
    expect(spawnedDeps.taskId).toBe("wf-1:task");
    expect(spawnedDeps.runId).toBe(openRun?.id);
    expect(spawnedDeps.provider).toBe(provider);
    expect(spawnedDeps.runtime).toBe(runtime);
    expect(typeof spawnedDeps.publish).toBe("function");
    expect(typeof spawnedDeps.now).toBe("function");
  });

  it("sad path: mark-running rejects → runtime.stop called for cleanup before error propagates", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo, "prior-session-ref");

    let markRunningCallCount = 0;
    const wrappedApply = vi.fn(async (cmd: Parameters<typeof applyCommand>[1]): Promise<CommandResult> => {
      if (cmd.kind === "transition-task" && cmd.transition.kind === "mark-running") {
        markRunningCallCount++;
        throw new DomainError("version_conflict", "concurrent update", { taskId: "wf-1:task" });
      }
      return applyCommand(repo, cmd);
    });

    const service = new ContinueTaskService({
      repo,
      applyCommand: wrappedApply,
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" }),
    ).rejects.toThrow();

    expect(markRunningCallCount).toBe(1);
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it("workspace.create failure: no provider.resume, no runtime.start, no mark-running", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const resumeSpy = vi.spyOn(provider, "resume");
    const startSpy = vi.spyOn(runtime, "start");

    await makeNeedsReviewTask(repo, "prior-session-ref");

    const workspace = new StubWorkspaceBackend();
    vi.spyOn(workspace, "create").mockRejectedValue(new Error("workspace unavailable"));

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" }),
    ).rejects.toThrow("workspace unavailable");

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    const wfAfter = await repo.get("wf-1");
    expect(wfAfter!.graph["wf-1:task"]!.executionStatus).toBe("needs-review");
  });

  it("runtime.start failure triggers workspace.cleanup", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    vi.spyOn(runtime, "start").mockRejectedValue(new Error("runtime unavailable"));
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo, "existing-ref");

    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" }),
    ).rejects.toThrow("runtime unavailable");

    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("workspace.create called with resetBranch: false to preserve prior agent commits", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo, "prior-session-ref");

    const workspace = new StubWorkspaceBackend();
    const createSpy = vi.spyOn(workspace, "create");

    const service = new ContinueTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" });

    expect(createSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ resetBranch: false }));
  });

  it("mark-running failure triggers runtime.stop AND workspace.cleanup", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo, "prior-session-ref");

    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");

    const wrappedApply = vi.fn(async (cmd: Parameters<typeof applyCommand>[1]): Promise<CommandResult> => {
      if (cmd.kind === "transition-task" && cmd.transition.kind === "mark-running") {
        throw new DomainError("version_conflict", "concurrent update", { taskId: "wf-1:task" });
      }
      return applyCommand(repo, cmd);
    });

    const service = new ContinueTaskService({
      repo,
      applyCommand: wrappedApply,
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "continue" }),
    ).rejects.toThrow();

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });
});
