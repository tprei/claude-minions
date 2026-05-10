import { DomainError } from "./errors.js";
import { WORKFLOW_KINDS } from "./types.js";
import type { TaskNode, TaskSpec, Workflow, WorkflowKind, WorkflowSpec } from "./types.js";

export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

export function createWorkflow(spec: WorkflowSpec, clock: Clock = systemClock): Workflow {
  if (!WORKFLOW_KINDS.includes(spec.kind as WorkflowKind)) {
    throw new DomainError("invalid_workflow", "unknown workflow kind", {
      workflowId: spec.id,
      kind: spec.kind,
    });
  }

  if (spec.tasks.length === 0) {
    throw new DomainError("invalid_workflow", "workflow must contain at least one task", {
      workflowId: spec.id,
    });
  }

  const now = clock();
  const ids = new Set<string>();

  for (const task of spec.tasks) {
    if (ids.has(task.id)) {
      throw new DomainError("invalid_workflow", "duplicate task id", { taskId: task.id });
    }
    ids.add(task.id);
  }

  const graph: Record<string, TaskNode> = {};

  for (const task of spec.tasks) {
    const dependsOn = task.dependsOn ?? [];
    const missing = dependsOn.filter((depId) => !ids.has(depId));
    if (missing.length > 0) {
      throw new DomainError("invalid_workflow", "task depends on unknown task", {
        taskId: task.id,
        missing,
      });
    }

    graph[task.id] = createTaskNode(spec.id, task, now);
  }

  assertAcyclic(graph);

  const workflow: Workflow = {
    id: spec.id,
    kind: spec.kind,
    status: "active",
    graph,
    operations: {},
    policy: {
      maxConcurrent: spec.policy?.maxConcurrent ?? 3,
      autoLand: spec.policy?.autoLand ?? false,
      autoMergeOnGreen: spec.policy?.autoMergeOnGreen ?? false,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  if (spec.directorSessionId !== undefined) workflow.directorSessionId = spec.directorSessionId;
  if (spec.createdFrom !== undefined) workflow.createdFrom = spec.createdFrom;

  return workflow;
}

export function createSingleTaskWorkflow(
  id: string,
  task: Omit<TaskSpec, "id"> & { id?: string },
  clock: Clock = systemClock,
): Workflow {
  return createWorkflow(
    {
      id,
      kind: "single-task",
      tasks: [{ ...task, id: task.id ?? `${id}:task` }],
      policy: { maxConcurrent: 1 },
    },
    clock,
  );
}

export function createThinkThreadWorkflow(
  id: string,
  task: Omit<TaskSpec, "id" | "mergeTarget"> & { id?: string },
  clock: Clock = systemClock,
): Workflow {
  return createWorkflow(
    {
      id,
      kind: "think-thread",
      tasks: [{ ...task, id: task.id ?? `${id}:think` }],
      policy: { maxConcurrent: 1 },
    },
    clock,
  );
}

function createTaskNode(workflowId: string, spec: TaskSpec, now: string): TaskNode {
  const task: TaskNode = {
    id: spec.id,
    workflowId,
    title: spec.title,
    prompt: spec.prompt,
    dependsOn: [...(spec.dependsOn ?? [])],
    executionStatus: "pending",
    stackStatus: "clean",
    priority: spec.priority ?? 0,
    claims: [...(spec.claims ?? [])],
    contract: {
      summary: spec.contract?.summary ?? spec.title,
      expectedArtifacts: [...(spec.contract?.expectedArtifacts ?? [])],
    },
    artifacts: [],
    runs: [],
    readiness: "unknown",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  if (spec.mergeTarget !== undefined) task.mergeTarget = spec.mergeTarget;

  return task;
}

function assertAcyclic(graph: Record<string, TaskNode>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new DomainError("invalid_workflow", "workflow graph contains a cycle", { taskId });
    }

    visiting.add(taskId);
    for (const depId of graph[taskId]?.dependsOn ?? []) {
      visit(depId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of Object.keys(graph)) {
    visit(taskId);
  }
}
