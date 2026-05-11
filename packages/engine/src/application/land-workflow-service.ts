import { DomainError } from "../domain/errors.js";
import type { TaskNode, Workflow } from "../domain/types.js";
import type { MergeService, MergeInput } from "./merge-service.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";

export interface LandWorkflowServiceDeps {
  repo: WorkflowRepository;
  mergeService: MergeService;
  log: Logger;
}

export interface LandWorkflowInput {
  workflowId: string;
  signal?: AbortSignal;
}

export interface LandWorkflowResult {
  workflowId: string;
  attempted: string[];
  merged: string[];
  skipped: string[];
  conflicted?: string;
}

export class LandWorkflowService {
  private readonly deps: LandWorkflowServiceDeps;

  constructor(deps: LandWorkflowServiceDeps) {
    this.deps = deps;
  }

  async run(input: LandWorkflowInput): Promise<LandWorkflowResult> {
    const workflow = await this.deps.repo.get(input.workflowId);
    if (!workflow) {
      throw new DomainError("not_found", "workflow not found", { workflowId: input.workflowId });
    }

    const ordered = topologicalOrderPrOpen(workflow);

    const attempted: string[] = [];
    const merged: string[] = [];
    const skipped: string[] = [];
    let conflicted: string | undefined;

    for (const task of ordered) {
      if (conflicted !== undefined) {
        skipped.push(task.id);
        continue;
      }

      attempted.push(task.id);

      const mergeInput: MergeInput = { workflowId: input.workflowId, taskId: task.id };
      if (input.signal !== undefined) mergeInput.signal = input.signal;

      const result = await this.deps.mergeService.merge(mergeInput);
      const updated = result.workflow.graph[task.id];
      if (!updated) {
        throw new DomainError("not_found", "task missing after merge", { taskId: task.id });
      }

      if (updated.executionStatus === "merged") {
        merged.push(task.id);
        this.deps.log.info("task merged in cascade", { workflowId: input.workflowId, taskId: task.id });
      } else if (updated.executionStatus === "needs-review") {
        conflicted = task.id;
        this.deps.log.info("cascade halted on merge conflict", {
          workflowId: input.workflowId,
          taskId: task.id,
        });
      } else {
        throw new DomainError("invalid_transition", "merge returned unexpected task status", {
          taskId: task.id,
          status: updated.executionStatus,
        });
      }
    }

    const out: LandWorkflowResult = {
      workflowId: input.workflowId,
      attempted,
      merged,
      skipped,
    };
    if (conflicted !== undefined) out.conflicted = conflicted;
    return out;
  }
}

function topologicalOrderPrOpen(workflow: Workflow): TaskNode[] {
  const candidates = Object.values(workflow.graph).filter(
    (task) => task.executionStatus === "pr-open",
  );
  const candidateIds = new Set(candidates.map((t) => t.id));

  const remainingDeps = new Map<string, Set<string>>(
    candidates.map((t) => [t.id, new Set(t.dependsOn.filter((d) => candidateIds.has(d)))]),
  );
  const remaining = new Map<string, TaskNode>(candidates.map((t) => [t.id, t]));

  const ordered: TaskNode[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((t) => (remainingDeps.get(t.id)?.size ?? 0) === 0)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (ready.length === 0) {
      throw new DomainError("invalid_workflow", "cannot topologically order pr-open tasks", {
        workflowId: workflow.id,
      });
    }

    const next = ready[0]!;
    ordered.push(next);
    remaining.delete(next.id);
    for (const deps of remainingDeps.values()) deps.delete(next.id);
  }

  return ordered;
}
