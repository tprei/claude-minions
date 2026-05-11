import type { WorkflowEvent } from "../domain/events.js";
import type { QualityPlugin, QualityRunResult } from "../plugins/quality-plugin.js";
import type { WorkspaceBackend } from "../plugins/workspace-backend.js";
import type { Command, CommandResult } from "./commands.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";

export interface QualityGateServiceDeps {
  workflowRepo: WorkflowRepository;
  workspace: WorkspaceBackend;
  plugin: QualityPlugin;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  signal: AbortSignal;
  now: () => string;
  defaultTimeoutMs?: number;
  log: Logger;
}

export class QualityGateService {
  private readonly deps: QualityGateServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent> | null>();
  private readonly taskControllers = new Map<string, AbortController>();

  constructor(deps: QualityGateServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const iter of this.activeIterators.values()) {
        if (iter !== null) void iter.return?.();
      }
      for (const ctrl of this.taskControllers.values()) ctrl.abort();
      this.taskControllers.clear();
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    this.activeIterators.set(workflowId, null);
    void this.attachAsync(workflowId);
  }

  detach(workflowId: string): void {
    const iter = this.activeIterators.get(workflowId);
    if (iter) void iter.return?.();
    this.activeIterators.delete(workflowId);

    for (const key of this.taskControllers.keys()) {
      if (key.startsWith(`${workflowId}:`)) {
        this.taskControllers.get(key)?.abort();
        this.taskControllers.delete(key);
      }
    }
  }

  private async attachAsync(workflowId: string): Promise<void> {
    const cursor = await this.deps.workflowRepo.latestCursor(workflowId);
    const workflow = await this.deps.workflowRepo.get(workflowId);
    if (!workflow) {
      this.activeIterators.delete(workflowId);
      return;
    }
    for (const [taskId, task] of Object.entries(workflow.graph)) {
      if (task.executionStatus === "completed") {
        this.spawnRunForTask(workflowId, taskId);
      }
    }
    void this.consume(workflowId, cursor);
  }

  private spawnRunForTask(workflowId: string, taskId: string): void {
    const key = `${workflowId}:${taskId}`;
    if (this.taskControllers.has(key)) return;
    const ctrl = new AbortController();
    this.taskControllers.set(key, ctrl);
    void this.runForTask(workflowId, taskId, ctrl.signal)
      .catch((err) => this.deps.log.error(`quality-gate: runForTask error for ${key}`, { error: (err as Error).message }))
      .finally(() => {
        if (this.taskControllers.get(key) === ctrl) this.taskControllers.delete(key);
      });
  }

  private async consume(workflowId: string, fromCursor?: number): Promise<void> {
    const latestCursor = fromCursor ?? await this.deps.workflowRepo.latestCursor(workflowId);
    const iterable = this.deps.workflowRepo.subscribe(workflowId, latestCursor);
    const iter = iterable[Symbol.asyncIterator]();
    this.activeIterators.set(workflowId, iter);
    try {
      while (true) {
        if (this.deps.signal.aborted) break;
        const result = await iter.next();
        if (result.done) break;
        if (this.deps.signal.aborted) break;

        const event = result.value;
        if (event.kind !== "task-transitioned") continue;

        const { taskId, fromExecutionStatus: from, toExecutionStatus: to } = event.payload;
        const key = `${workflowId}:${taskId}`;

        if (to === "completed" && from !== "completed") {
          this.spawnRunForTask(workflowId, taskId);
        } else if (
          (from === "completed" && to !== "completed" && to !== "quality-pending") ||
          (from === "quality-pending" && to !== "quality-pending")
        ) {
          const ctrl = this.taskControllers.get(key);
          if (ctrl) {
            ctrl.abort();
            this.taskControllers.delete(key);
          }
        }
      }
    } catch (err) {
      this.deps.log.error(`quality-gate: consume error for ${workflowId}`, { error: (err as Error).message });
    } finally {
      this.activeIterators.delete(workflowId);
    }
  }

  private async runForTask(workflowId: string, taskId: string, signal: AbortSignal): Promise<void> {
    const { workflowRepo, workspace, plugin, applyCommand, now, defaultTimeoutMs } = this.deps;

    const workflow = await workflowRepo.get(workflowId);
    const task = workflow?.graph[taskId];
    if (!task || task.executionStatus !== "completed") return;
    if (!task.workspaceId) {
      this.deps.log.error(`quality-gate: task ${taskId} has no workspaceId, skipping`, { taskId, workflowId });
      return;
    }

    const handle = await workspace.get(task.workspaceId);
    if (!handle) {
      const artifact = {
        kind: "quality-report" as const,
        ref: JSON.stringify({ overallStatus: "failed", checks: [], ranAt: now(), reason: "workspace-missing" }),
        producedBy: "quality-gate",
        createdAt: now(),
      };
      await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: { kind: "start-quality-gate", taskId, now: now() },
      }).catch(() => {});
      await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: { kind: "complete-quality-gate", taskId, passed: false, artifacts: [artifact], now: now() },
      }).catch(() => {});
      return;
    }

    try {
      await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: { kind: "start-quality-gate", taskId, now: now() },
      });
    } catch {
      return;
    }

    if (signal.aborted) return;

    let configs: Awaited<ReturnType<typeof plugin.loadConfig>>;
    try {
      configs = await plugin.loadConfig(handle.path);
    } catch (err) {
      const artifact = {
        kind: "quality-report" as const,
        ref: JSON.stringify({
          overallStatus: "failed",
          checks: [],
          ranAt: now(),
          reason: "config-error",
          error: (err as Error).message,
        }),
        producedBy: "quality-gate",
        createdAt: now(),
      };
      await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: { kind: "complete-quality-gate", taskId, passed: false, artifacts: [artifact], now: now() },
      }).catch(() => {});
      return;
    }

    if (signal.aborted) return;

    if (configs.length === 0) {
      const artifact = {
        kind: "quality-report" as const,
        ref: JSON.stringify({ overallStatus: "passed", checks: [], ranAt: now() }),
        producedBy: "quality-gate",
        createdAt: now(),
      };
      await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: { kind: "complete-quality-gate", taskId, passed: true, artifacts: [artifact], now: now() },
      });
      return;
    }

    let result: QualityRunResult;
    try {
      const runOpts: { signal?: AbortSignal; defaultTimeoutMs?: number } = { signal };
      if (defaultTimeoutMs !== undefined) runOpts.defaultTimeoutMs = defaultTimeoutMs;
      result = await plugin.run(configs, handle.path, runOpts);
    } catch (err) {
      this.deps.log.error(`quality-gate: plugin.run threw for ${workflowId}:${taskId}`, { taskId, workflowId, error: (err as Error).message });
      const artifact = {
        kind: "quality-report" as const,
        ref: JSON.stringify({
          overallStatus: "failed",
          checks: [],
          ranAt: now(),
          reason: "plugin-error",
          error: (err as Error).message,
        }),
        producedBy: "quality-gate",
        createdAt: now(),
      };
      await applyCommand({
        kind: "transition-task",
        workflowId,
        transition: { kind: "complete-quality-gate", taskId, passed: false, artifacts: [artifact], now: now() },
      }).catch(() => {});
      return;
    }

    if (signal.aborted) return;

    const artifact = {
      kind: "quality-report" as const,
      ref: JSON.stringify({
        overallStatus: result.status,
        checks: result.checks,
        ranAt: now(),
      }),
      producedBy: "quality-gate",
      createdAt: now(),
    };

    await applyCommand({
      kind: "transition-task",
      workflowId,
      transition: {
        kind: "complete-quality-gate",
        taskId,
        passed: result.status === "passed",
        artifacts: [artifact],
        now: now(),
      },
    });
  }
}
