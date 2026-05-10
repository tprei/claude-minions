import { findClaimConflicts } from "../domain/claims.js";
import type { Artifact, TaskNode, Workflow } from "../domain/types.js";
import { TASK_AGENT_OCCUPYING_STATUSES, TASK_CLAIM_HOLDING_STATUSES, TASK_SUCCESS_EXECUTION_STATUSES } from "../domain/types.js";

export interface DispatchCandidate {
  task: TaskNode;
  dependencyArtifacts: Artifact[];
}

export function planDispatch(workflow: Workflow): DispatchCandidate[] {
  if (workflow.status !== "active") return [];

  const agentOccupying = Object.values(workflow.graph).filter((task) =>
    TASK_AGENT_OCCUPYING_STATUSES.has(task.executionStatus),
  );
  const capacity = Math.max(0, workflow.policy.maxConcurrent - agentOccupying.length);
  if (capacity === 0) return [];

  const claimHolders = Object.values(workflow.graph).filter((task) =>
    TASK_CLAIM_HOLDING_STATUSES.has(task.executionStatus),
  );

  const candidates = Object.values(workflow.graph)
    .filter((task) => task.executionStatus === "pending")
    .filter((task) => task.stackStatus === "clean")
    .filter((task) => dependenciesSucceeded(workflow, task))
    .filter((task) => claimsAvailable(task, claimHolders))
    .sort(compareDispatchPriority);

  return candidates.slice(0, capacity).map((task) => ({
    task,
    dependencyArtifacts: dependencyArtifactsFor(workflow, task.id),
  }));
}

export function dependencyArtifactsFor(workflow: Workflow, taskId: string): Artifact[] {
  const task = workflow.graph[taskId];
  if (!task) return [];

  return task.dependsOn.flatMap((depId) => workflow.graph[depId]?.artifacts ?? []);
}

function dependenciesSucceeded(workflow: Workflow, task: TaskNode): boolean {
  return task.dependsOn.every((depId) => {
    const dependency = workflow.graph[depId];
    return (
      dependency !== undefined &&
      TASK_SUCCESS_EXECUTION_STATUSES.has(dependency.executionStatus) &&
      dependency.stackStatus === "clean"
    );
  });
}

function claimsAvailable(task: TaskNode, claimHolders: readonly TaskNode[]): boolean {
  return claimHolders.every((holder) => {
    if (holder.id === task.id) return true;
    return findClaimConflicts(task.claims, holder.claims).length === 0;
  });
}

function compareDispatchPriority(left: TaskNode, right: TaskNode): number {
  if (right.priority !== left.priority) return right.priority - left.priority;
  return left.id.localeCompare(right.id);
}
