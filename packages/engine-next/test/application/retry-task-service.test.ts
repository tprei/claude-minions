import { describe, expect, it, vi } from "vitest";
import { RetryTaskService } from "../../src/application/retry-task-service.js";
import { applyCommand } from "../../src/application/commands.js";
import type { CommandResult } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { DomainError } from "../../src/domain/errors.js";
import { createSingleTaskWorkflow, createWorkflow } from "../../src/domain/workflow.js";
import { getOpenRun } from "../../src/domain/runs.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";
import { StubWorkspaceBackend } from "../../src/plugins/workspace/stub-workspace.js";
import type { NodeRun } from "../../src/domain/runs.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";
import type { Artifact } from "../../src/domain/types.js";

const now = "2026-05-06T10:00:00.000Z";

async function makeNeedsReviewTask(repo: InMemoryWorkflowRepository) {
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
}

describe("RetryTaskService", () => {
  it("happy path: task in needs-review → prepare called once, resume not called, attempt N+1, no providerSessionRef", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const prepareSpy = vi.spyOn(provider, "prepare");
    const resumeSpy = vi.spyOn(provider, "resume");

    await makeNeedsReviewTask(repo);

    const wfCurrent = await repo.get("wf-1");
    const task = wfCurrent!.graph["wf-1:task"]!;
    const patchedRun: NodeRun = { ...task.runs[0]!, providerSessionRef: "old-session" };
    const patchedWf = {
      ...wfCurrent!,
      version: wfCurrent!.version + 1,
      graph: { "wf-1:task": { ...task, runs: [patchedRun] } },
    };
    await repo.save(patchedWf, []);

    const spawnOrchestrator = vi.fn();
    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator,
    });

    const result = await service.run({
      workflowId: "wf-1",
      taskId: "wf-1:task",
      prompt: "start fresh",
    });

    expect(prepareSpy).toHaveBeenCalledOnce();
    expect(prepareSpy).toHaveBeenCalledWith({
      taskId: "wf-1:task",
      workflowId: "wf-1",
      prompt: "start fresh",
      dependencyArtifacts: [],
    });
    expect(resumeSpy).not.toHaveBeenCalled();

    const taskPost = result.workflow.graph["wf-1:task"]!;
    expect(taskPost.executionStatus).toBe("running");
    expect(taskPost.runs).toHaveLength(2);
    expect(taskPost.runs[1]?.attempt).toBe(2);
    expect(taskPost.runs[1]?.providerSessionRef).toBeUndefined();
  });

  it("happy path with dep artifacts: child task retry receives parent's artifacts in prepare call", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });
    const prepareSpy = vi.spyOn(provider, "prepare");

    const parentArtifact: Artifact = { kind: "commit", ref: "abc123", producedBy: "wf-2:parent", createdAt: now };

    const wf = createWorkflow({
      id: "wf-2",
      kind: "single-task",
      tasks: [
        { id: "wf-2:parent", title: "Parent", prompt: "do parent" },
        { id: "wf-2:child", title: "Child", prompt: "do child", dependsOn: ["wf-2:parent"] },
      ],
      policy: { maxConcurrent: 2 },
    }, () => now);
    await repo.save(wf, []);

    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-2",
      transition: { kind: "mark-ready", taskId: "wf-2:child", now },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-2",
      transition: { kind: "mark-running", taskId: "wf-2:child", sessionId: "s-child", now },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-2",
      transition: { kind: "mark-interrupted", taskId: "wf-2:child", now },
    });

    const wfCurrent = await repo.get("wf-2");
    const parentNode = wfCurrent!.graph["wf-2:parent"]!;
    const patchedParent = { ...parentNode, artifacts: [parentArtifact] };
    const patchedWf = {
      ...wfCurrent!,
      version: wfCurrent!.version + 1,
      graph: { ...wfCurrent!.graph, "wf-2:parent": patchedParent },
    };
    await repo.save(patchedWf, []);

    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    await service.run({ workflowId: "wf-2", taskId: "wf-2:child", prompt: "retry child" });

    expect(prepareSpy).toHaveBeenCalledOnce();
    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dependencyArtifacts: [parentArtifact] }),
    );
  });

  it("happy path zero prior runs: task forced to needs-review with empty runs, retry produces attempt 1", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    const wf = createSingleTaskWorkflow("wf-3", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);

    const wfCurrent = await repo.get("wf-3");
    const task = wfCurrent!.graph["wf-3:task"]!;
    const patchedWf = {
      ...wfCurrent!,
      version: wfCurrent!.version + 1,
      graph: { "wf-3:task": { ...task, executionStatus: "needs-review" as const, runs: [] } },
    };
    await repo.save(patchedWf, []);

    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    const result = await service.run({ workflowId: "wf-3", taskId: "wf-3:task", prompt: "first try" });

    const taskPost = result.workflow.graph["wf-3:task"]!;
    expect(taskPost.executionStatus).toBe("running");
    expect(taskPost.runs).toHaveLength(1);
    expect(taskPost.runs[0]?.attempt).toBe(1);
  });

  it("sad path: task in ready → throws invalid_transition, prepare and runtime.start not called", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const prepareSpy = vi.spyOn(provider, "prepare");
    const startSpy = vi.spyOn(runtime, "start");

    const wf = createSingleTaskWorkflow("wf-1", { title: "T", prompt: "P" }, () => now);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: "wf-1",
      transition: { kind: "mark-ready", taskId: "wf-1:task", now },
    });

    const service = new RetryTaskService({
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
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect((caughtErr as DomainError).message).toContain("ready");
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("sad path: task in running → throws invalid_transition, prepare not called", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const prepareSpy = vi.spyOn(provider, "prepare");

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

    const service = new RetryTaskService({
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
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("sad path: task stackStatus is restack-pending → throws invalid_transition, prepare not called", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const prepareSpy = vi.spyOn(provider, "prepare");

    await makeNeedsReviewTask(repo);

    const wfCurrent = await repo.get("wf-1");
    const task = wfCurrent!.graph["wf-1:task"]!;
    const patchedWf = {
      ...wfCurrent!,
      version: wfCurrent!.version + 1,
      graph: { "wf-1:task": { ...task, stackStatus: "restack-pending" as const } },
    };
    await repo.save(patchedWf, []);

    const service = new RetryTaskService({
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
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect((caughtErr as DomainError).message).toContain("restack-pending");
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("race window: stackStatus flips to restack-pending between preflight and mark-running → mark-running rejects, runtime.stop called", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo);

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

    const service = new RetryTaskService({
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
      await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(DomainError);
    expect((caughtErr as DomainError).code).toBe("invalid_transition");
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it("sad path: provider.prepare rejects → error propagates, task stays needs-review, runtime.start not called", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    vi.spyOn(provider, "prepare").mockRejectedValue(new Error("provider unavailable"));
    const startSpy = vi.spyOn(runtime, "start");

    await makeNeedsReviewTask(repo);

    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" }),
    ).rejects.toThrow("provider unavailable");

    const wfAfter = await repo.get("wf-1");
    expect(wfAfter!.graph["wf-1:task"]!.executionStatus).toBe("needs-review");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("sad path: runtime.start rejects → error propagates, task stays needs-review", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    vi.spyOn(runtime, "start").mockRejectedValue(new Error("runtime unavailable"));
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo);

    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" }),
    ).rejects.toThrow("runtime unavailable");

    const wfAfter = await repo.get("wf-1");
    expect(wfAfter!.graph["wf-1:task"]!.executionStatus).toBe("needs-review");
  });

  it("sad path: mark-running rejects → runtime.stop called for cleanup before error propagates", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo);

    let markRunningCallCount = 0;
    const wrappedApply = vi.fn(async (cmd: Parameters<typeof applyCommand>[1]): Promise<CommandResult> => {
      if (cmd.kind === "transition-task" && cmd.transition.kind === "mark-running") {
        markRunningCallCount++;
        throw new DomainError("version_conflict", "concurrent update", { taskId: "wf-1:task" });
      }
      return applyCommand(repo, cmd);
    });

    const service = new RetryTaskService({
      repo,
      applyCommand: wrappedApply,
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" }),
    ).rejects.toThrow();

    expect(markRunningCallCount).toBe(1);
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it("spawnOrchestrator called once with expected deps shape", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo);

    const spawnOrchestrator = vi.fn();
    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace: new StubWorkspaceBackend(),
      spawnOrchestrator,
    });

    await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" });

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

  it("workspace.create failure: no provider.prepare, no runtime.start, no mark-running", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const provider = new StubProviderPlugin({ frames: [] });
    const prepareSpy = vi.spyOn(provider, "prepare");
    const startSpy = vi.spyOn(runtime, "start");

    await makeNeedsReviewTask(repo);

    const workspace = new StubWorkspaceBackend();
    vi.spyOn(workspace, "create").mockRejectedValue(new Error("workspace unavailable"));

    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" }),
    ).rejects.toThrow("workspace unavailable");

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    const wfAfter = await repo.get("wf-1");
    expect(wfAfter!.graph["wf-1:task"]!.executionStatus).toBe("needs-review");
  });

  it("runtime.start failure triggers workspace.cleanup", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    vi.spyOn(runtime, "start").mockRejectedValue(new Error("runtime unavailable"));
    const provider = new StubProviderPlugin({ frames: [] });

    await makeNeedsReviewTask(repo);

    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");

    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" }),
    ).rejects.toThrow("runtime unavailable");

    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("workspace.create called with resetBranch: true to discard prior agent commits", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo);

    const workspace = new StubWorkspaceBackend();
    const createSpy = vi.spyOn(workspace, "create");

    const service = new RetryTaskService({
      repo,
      applyCommand: (cmd) => applyCommand(repo, cmd),
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" });

    expect(createSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ resetBranch: true }));
  });

  it("mark-running failure triggers runtime.stop AND workspace.cleanup", async () => {
    const repo = new InMemoryWorkflowRepository();
    const runtime = new StubRuntimeBackend();
    const stopSpy = vi.spyOn(runtime, "stop");
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "new-session" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    await makeNeedsReviewTask(repo);

    const workspace = new StubWorkspaceBackend();
    const cleanupSpy = vi.spyOn(workspace, "cleanup");

    const wrappedApply = vi.fn(async (cmd: Parameters<typeof applyCommand>[1]): Promise<CommandResult> => {
      if (cmd.kind === "transition-task" && cmd.transition.kind === "mark-running") {
        throw new DomainError("version_conflict", "concurrent update", { taskId: "wf-1:task" });
      }
      return applyCommand(repo, cmd);
    });

    const service = new RetryTaskService({
      repo,
      applyCommand: wrappedApply,
      providerFactory: () => provider,
      runtime,
      now: () => now,
      workspace,
      spawnOrchestrator: vi.fn(),
    });

    await expect(
      service.run({ workflowId: "wf-1", taskId: "wf-1:task", prompt: "retry" }),
    ).rejects.toThrow();

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });
});
