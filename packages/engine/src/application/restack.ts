import { DomainError } from "../domain/errors.js";
import type { Artifact, GraphOperation, GraphOperationStatus, TaskNode, Workflow } from "../domain/types.js";

export interface RestackPlan {
  ancestorId: string;
  descendants: TaskNode[];
}

export interface RequestRestackInput {
  operationId: string;
  ancestorId: string;
  idempotencyKey: string;
  fromBase?: string;
  toBase?: string;
  now: string;
}

export interface RequestRestackResult {
  workflow: Workflow;
  operation: GraphOperation;
}

export interface CompleteRestackInput {
  operationId: string;
  artifactsByTaskId?: Record<string, Artifact[]>;
  now: string;
}

export function planRestack(workflow: Workflow, ancestorId: string): RestackPlan {
  const descendantIds = collectDescendantIds(workflow, ancestorId);
  const ordered = topologicalTasks(workflow).filter((task) => descendantIds.has(task.id));

  return {
    ancestorId,
    descendants: ordered,
  };
}

export function requestRestack(workflow: Workflow, input: RequestRestackInput): RequestRestackResult {
  const existing = Object.values(workflow.operations).find(
    (operation) => operation.idempotencyKey === input.idempotencyKey,
  );
  if (existing) return { workflow, operation: existing };

  const plan = planRestack(workflow, input.ancestorId);
  const affectedNodeIds = plan.descendants.map((task) => task.id);
  const operation = createRestackOperation(workflow.id, affectedNodeIds, input);
  const graph = { ...workflow.graph };

  for (const nodeId of affectedNodeIds) {
    const task = graph[nodeId];
    if (!task) continue;
    graph[nodeId] = {
      ...task,
      stackStatus: "restack-pending",
      version: task.version + 1,
      updatedAt: input.now,
    };
  }

  const nextWorkflow: Workflow = {
    ...workflow,
    graph,
    operations: { ...workflow.operations, [operation.id]: operation },
    version: workflow.version + 1,
    updatedAt: input.now,
  };

  return { workflow: nextWorkflow, operation };
}

export function startRestackOperation(workflow: Workflow, operationId: string, now: string): Workflow {
  const operation = requireOperation(workflow, operationId, ["pending"]);
  return updateRestackOperation(workflow, operation, "running", now, "restacking");
}

export function completeRestackOperation(workflow: Workflow, input: CompleteRestackInput): Workflow {
  const operation = requireOperation(workflow, input.operationId, ["running"]);
  const graph = { ...workflow.graph };

  for (const nodeId of operation.affectedNodeIds) {
    const task = graph[nodeId];
    if (!task) continue;
    graph[nodeId] = {
      ...task,
      stackStatus: "clean",
      artifacts: [...task.artifacts, ...(input.artifactsByTaskId?.[nodeId] ?? [])],
      version: task.version + 1,
      updatedAt: input.now,
    };
  }

  const nextOperation = {
    ...operation,
    status: "completed" as const,
    updatedAt: input.now,
  };

  return {
    ...workflow,
    graph,
    operations: { ...workflow.operations, [operation.id]: nextOperation },
    version: workflow.version + 1,
    updatedAt: input.now,
  };
}

export function markRestackConflict(
  workflow: Workflow,
  operationId: string,
  error: string,
  now: string,
): Workflow {
  const operation = requireOperation(workflow, operationId, ["running"]);
  const graph = { ...workflow.graph };

  for (const nodeId of operation.affectedNodeIds) {
    const task = graph[nodeId];
    if (!task) continue;
    graph[nodeId] = {
      ...task,
      stackStatus: "restack-conflict",
      version: task.version + 1,
      updatedAt: now,
    };
  }

  const nextOperation = {
    ...operation,
    status: "conflict" as const,
    error,
    updatedAt: now,
  };

  return {
    ...workflow,
    graph,
    operations: { ...workflow.operations, [operation.id]: nextOperation },
    version: workflow.version + 1,
    updatedAt: now,
  };
}

function createRestackOperation(
  workflowId: string,
  affectedNodeIds: string[],
  input: RequestRestackInput,
): GraphOperation {
  const operation: GraphOperation = {
    id: input.operationId,
    workflowId,
    kind: "restack",
    targetNodeId: input.ancestorId,
    affectedNodeIds,
    status: "pending",
    attempt: 0,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.now,
    updatedAt: input.now,
  };

  if (input.fromBase !== undefined) operation.fromBase = input.fromBase;
  if (input.toBase !== undefined) operation.toBase = input.toBase;

  return operation;
}

function requireOperation(
  workflow: Workflow,
  operationId: string,
  allowed: GraphOperationStatus[],
): GraphOperation {
  const operation = workflow.operations[operationId];
  if (!operation) {
    throw new DomainError("not_found", "graph operation not found", { operationId });
  }
  if (!allowed.includes(operation.status)) {
    throw new DomainError("invalid_transition", "graph operation status does not allow transition", {
      operationId,
      status: operation.status,
      allowed,
    });
  }
  return operation;
}

function updateRestackOperation(
  workflow: Workflow,
  operation: GraphOperation,
  status: GraphOperationStatus,
  now: string,
  stackStatus: TaskNode["stackStatus"],
): Workflow {
  const graph = { ...workflow.graph };

  for (const nodeId of operation.affectedNodeIds) {
    const task = graph[nodeId];
    if (!task) continue;
    graph[nodeId] = {
      ...task,
      stackStatus,
      version: task.version + 1,
      updatedAt: now,
    };
  }

  const nextOperation = {
    ...operation,
    status,
    attempt: status === "running" ? operation.attempt + 1 : operation.attempt,
    updatedAt: now,
  };

  return {
    ...workflow,
    graph,
    operations: { ...workflow.operations, [operation.id]: nextOperation },
    version: workflow.version + 1,
    updatedAt: now,
  };
}

function collectDescendantIds(workflow: Workflow, ancestorId: string): Set<string> {
  const descendants = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const task of Object.values(workflow.graph)) {
      const hasKnownParent = task.dependsOn.some((depId) => depId === ancestorId || descendants.has(depId));
      if (hasKnownParent && !descendants.has(task.id)) {
        descendants.add(task.id);
        changed = true;
      }
    }
  }

  return descendants;
}

function topologicalTasks(workflow: Workflow): TaskNode[] {
  const remaining = new Set(Object.keys(workflow.graph));
  const ordered: TaskNode[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((taskId) => workflow.graph[taskId])
      .filter((task): task is TaskNode => task !== undefined)
      .filter((task) => task.dependsOn.every((depId) => !remaining.has(depId)))
      .sort((left, right) => left.id.localeCompare(right.id));

    if (ready.length === 0) break;

    for (const task of ready) {
      ordered.push(task);
      remaining.delete(task.id);
    }
  }

  return ordered;
}
