import { DomainError } from "../domain/errors.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.js";
import type { RuntimeBackend } from "../plugins/runtime-backend.js";
import type { WorkspaceBackend } from "../plugins/workspace-backend.js";
import { slugify } from "../plugins/workspace-backend.js";
import type { Command, CommandResult } from "./commands.js";
import type { WorkflowRepository } from "./repository.js";
import type { RunOrchestratorDeps } from "./run-orchestrator.js";
import { getOpenRun } from "../domain/runs.js";
import { dependencyArtifactsFor } from "./scheduler.js";
import type { WorkflowEvent } from "../domain/events.js";

export interface RetryTaskServiceDeps {
  repo: WorkflowRepository;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  providerFactory: () => ProviderPlugin;
  runtime: RuntimeBackend;
  workspace: WorkspaceBackend;
  now: () => string;
  spawnOrchestrator: (deps: Omit<RunOrchestratorDeps, "signal" | "log">) => void;
}

export interface RetryTaskInput {
  workflowId: string;
  taskId: string;
  prompt: string;
}

function deriveBranch(workflowId: string, taskId: string): string {
  return `minions/${slugify(workflowId)}_${slugify(taskId)}`;
}

export class RetryTaskService {
  private readonly deps: RetryTaskServiceDeps;

  constructor(deps: RetryTaskServiceDeps) {
    this.deps = deps;
  }

  async run(input: RetryTaskInput): Promise<CommandResult> {
    const { workflowId, taskId, prompt } = input;
    const { repo, applyCommand, providerFactory, runtime, workspace, now, spawnOrchestrator } = this.deps;

    const workflow = await repo.get(workflowId);
    if (!workflow) {
      throw new DomainError("not_found", "workflow not found", { workflowId });
    }

    const task = workflow.graph[taskId];
    if (!task) {
      throw new DomainError("not_found", "task not found", { taskId });
    }

    if (task.executionStatus !== "needs-review") {
      throw new DomainError("invalid_transition",
        `retry-task requires task in needs-review, got ${task.executionStatus}`,
        { taskId, currentStatus: task.executionStatus });
    }

    if (task.stackStatus !== "clean") {
      throw new DomainError("invalid_transition",
        `task stack is ${task.stackStatus}; must be clean before retry`,
        { taskId, stackStatus: task.stackStatus });
    }

    const depArtifacts = dependencyArtifactsFor(workflow, taskId);

    const handle = await workspace.create({
      workflowId,
      taskId,
      branch: deriveBranch(workflowId, taskId),
      mode: "worktree",
      resetBranch: true,
    });

    try {
      const provider = providerFactory();
      const invocation = await provider.prepare({ taskId, workflowId, prompt, dependencyArtifacts: depArtifacts });
      const startSpec: { taskId: string; workflowId: string; command: string[]; env?: Record<string, string>; workspacePath?: string } = {
        taskId,
        workflowId,
        command: invocation.command,
        workspacePath: handle.containerPath,
      };
      if (invocation.env !== undefined) startSpec.env = invocation.env;
      const { sessionId: runtimeSessionId, runtimeType } = await runtime.start(startSpec);

      let runningResult: CommandResult;
      try {
        runningResult = await applyCommand({
          kind: "transition-task",
          workflowId,
          transition: {
            kind: "mark-running",
            taskId,
            sessionId: runtimeSessionId,
            providerType: invocation.providerType,
            runtimeType,
            workspaceId: handle.workspaceId,
            now: now(),
          },
        });
      } catch (err) {
        await runtime.stop(runtimeSessionId).catch(() => {});
        throw err;
      }

      const postTask = runningResult.workflow.graph[taskId];
      const openRun = postTask ? getOpenRun(postTask.runs) : undefined;
      if (!openRun) throw new DomainError("invalid_transition", "no open run after mark-running", { taskId });
      const runId = openRun.id;

      spawnOrchestrator({
        workflowId,
        taskId,
        runId,
        runtimeSessionId,
        provider,
        runtime,
        workspace,
        workspaceId: handle.workspaceId,
        applyCommand,
        publish: (providerEvent) => {
          const envelope: WorkflowEvent = {
            cursor: 0,
            workflowId,
            occurredAt: now(),
            kind: "provider-event",
            payload: { taskId, runId, providerEvent },
          };
          repo.publishTransient(workflowId, envelope);
        },
        now,
      });

      return runningResult;
    } catch (err) {
      await workspace.cleanup(handle.workspaceId).catch(() => {});
      throw err;
    }
  }
}
