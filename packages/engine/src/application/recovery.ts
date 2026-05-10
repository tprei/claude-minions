import type { GraphOperation, TaskNode, Workflow } from "../domain/types.js";

export type RuntimeProbeState = "live" | "dead" | "missing";

export type RecoveryActionKind =
  | "recover-task"
  | "interrupt-task"
  | "probe-gate"
  | "stop-runtime"
  | "operator-review"
  | "resume-graph-operation";

export type RecoveryAction = TaskRecoveryAction | GraphOperationRecoveryAction;

export interface TaskRecoveryAction {
  kind: Exclude<RecoveryActionKind, "resume-graph-operation">;
  taskId: string;
  reason: string;
  sessionId?: string;
}

export interface GraphOperationRecoveryAction {
  kind: "resume-graph-operation";
  operationId: string;
  reason: string;
}

export interface RecoveryOptions {
  nowMs: number;
  staleReadyMs: number;
  staleGateMs: number;
  runtimeProbes?: Record<string, RuntimeProbeState>;
  workflowCancelled?: boolean;
}

interface TaskRecoveryRule {
  name: string;
  matches: (task: TaskNode, options: RecoveryOptions) => boolean;
  emit: (task: TaskNode, options: RecoveryOptions) => TaskRecoveryAction;
}

interface GraphOperationRecoveryRule {
  name: string;
  matches: (operation: GraphOperation) => boolean;
  emit: (operation: GraphOperation) => GraphOperationRecoveryAction;
}

const TASK_RULES: TaskRecoveryRule[] = [
  {
    name: "workflow-cancelled-with-runtime",
    matches: (task, options) => Boolean(options.workflowCancelled && task.sessionId),
    emit: (task) => withSession(
      { kind: "stop-runtime", taskId: task.id, reason: "workflow cancelled with live runtime" },
      task.sessionId,
    ),
  },
  {
    name: "stale-ready-no-session",
    matches: (task, options) =>
      task.executionStatus === "ready" &&
      !task.sessionId &&
      ageMs(task, options.nowMs) >= options.staleReadyMs,
    emit: (task) => ({ kind: "recover-task", taskId: task.id, reason: "stale ready task" }),
  },
  {
    name: "running-without-session",
    matches: (task) => task.executionStatus === "running" && !task.sessionId,
    emit: (task) => ({
      kind: "recover-task",
      taskId: task.id,
      reason: "running task has no session",
    }),
  },
  {
    name: "running-with-dead-probe",
    matches: (task, options) =>
      task.executionStatus === "running" &&
      !!task.sessionId &&
      options.runtimeProbes?.[task.sessionId] === "dead",
    emit: (task) => withSession(
      { kind: "recover-task", taskId: task.id, reason: "runtime probe is dead" },
      task.sessionId,
    ),
  },
  {
    name: "running-with-missing-probe",
    matches: (task, options) =>
      task.executionStatus === "running" &&
      !!task.sessionId &&
      options.runtimeProbes?.[task.sessionId] === "missing",
    emit: (task) => withSession(
      { kind: "interrupt-task", taskId: task.id, reason: "runtime probe is missing" },
      task.sessionId,
    ),
  },
  {
    name: "stale-gate",
    matches: (task, options) =>
      (task.executionStatus === "quality-pending" || task.executionStatus === "ci-pending") &&
      ageMs(task, options.nowMs) >= options.staleGateMs,
    emit: (task) => ({
      kind: "probe-gate",
      taskId: task.id,
      reason: `${task.executionStatus} timed out`,
    }),
  },
];

const OPERATION_RULES: GraphOperationRecoveryRule[] = [
  {
    name: "in-flight-graph-operation",
    matches: (operation) => operation.status === "pending" || operation.status === "running",
    emit: (operation) => ({
      kind: "resume-graph-operation",
      operationId: operation.id,
      reason: `${operation.kind} operation is ${operation.status}`,
    }),
  },
];

// Operations whose recovery loop should re-attempt them after a crash.
const NON_TERMINAL_OPERATION_STATUSES: ReadonlySet<GraphOperation["status"]> = new Set([
  "pending",
  "running",
]);

export function hasNonTerminalOperation(workflow: Workflow): boolean {
  for (const operation of Object.values(workflow.operations)) {
    if (NON_TERMINAL_OPERATION_STATUSES.has(operation.status)) return true;
  }
  return false;
}

export function planRecovery(workflow: Workflow, options: RecoveryOptions): RecoveryAction[] {
  const actions: RecoveryAction[] = [];

  for (const task of Object.values(workflow.graph)) {
    const rule = TASK_RULES.find((candidate) => candidate.matches(task, options));
    if (rule) actions.push(rule.emit(task, options));
  }

  for (const operation of Object.values(workflow.operations)) {
    const rule = OPERATION_RULES.find((candidate) => candidate.matches(operation));
    if (rule) actions.push(rule.emit(operation));
  }

  return actions;
}

function ageMs(task: TaskNode, nowMs: number): number {
  return nowMs - new Date(task.updatedAt).getTime();
}

function withSession(action: TaskRecoveryAction, sessionId: string | undefined): TaskRecoveryAction {
  if (sessionId === undefined) return action;
  return { ...action, sessionId };
}
