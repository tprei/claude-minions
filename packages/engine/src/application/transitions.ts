import { DomainError } from "../domain/errors.js";
import { appendRun, closeLatestRun, patchOpenRun } from "../domain/runs.js";
import type { NodeRun, NodeRunTerminalReason } from "../domain/runs.js";
import type { Artifact, TaskExecutionStatus, TaskNode, Workflow } from "../domain/types.js";
import { TASK_WORKFLOW_COMPLETING_STATUSES } from "../domain/types.js";

export const TRANSITION_KINDS = [
  "mark-ready",
  "mark-running",
  "update-run",
  "complete-runtime",
  "start-finalization",
  "open-review",
  "start-quality-gate",
  "complete-quality-gate",
  "start-ci-gate",
  "complete-ci-gate",
  "merge-task",
  "complete-without-pr",
  "merge-conflict",
  "cancel-task",
  "clear-session",
  "recover-task",
  "mark-interrupted",
  "fail-task",
] as const;

export type TransitionKind = typeof TRANSITION_KINDS[number];

export interface TransitionCommand {
  kind: TransitionKind;
  taskId: string;
  expectedVersion?: number;
  expectedSessionId?: string;
  sessionId?: string;
  providerType?: string;
  runtimeType?: string;
  providerSessionRef?: string;
  outputOffset?: number;
  artifacts?: Artifact[];
  passed?: boolean;
  reason?: string;
  workspaceId?: string;
  now: string;
}

interface TransitionEffect {
  patch: Partial<TaskNode>;
  clearSession?: boolean;
  runEffect?:
    | { kind: "append"; run: NodeRun }
    | { kind: "close"; reason: NodeRunTerminalReason; exitMetadata?: Record<string, unknown> }
    | { kind: "patch-open-run"; patch: { providerSessionRef?: string; outputOffset?: number } };
}

interface TransitionRule {
  from: TaskExecutionStatus[];
  apply: (task: TaskNode, command: TransitionCommand) => TransitionEffect;
}

const appendArtifacts = (task: TaskNode, command: TransitionCommand): Artifact[] => [
  ...task.artifacts,
  ...(command.artifacts ?? []),
];

const MAX_STREAM_IDLE_AUTO_RECOVERIES = 3;
const DEPENDENCY_BLOCKING_EXECUTION_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set([
  "failed",
  "cancelled",
]);

function countStreamIdleAutoRecoveries(runs: readonly NodeRun[]): number {
  return runs.filter((run) => run.terminalReason === "recovered" && run.exitMetadata?.["streamIdleAutoRecovered"] === true).length;
}

const TRANSITIONS: Record<TransitionKind, TransitionRule> = {
  "mark-ready": {
    from: ["pending"],
    apply: () => ({ patch: { executionStatus: "ready" } }),
  },
  "mark-running": {
    from: ["ready", "needs-review", "pr-open"],
    apply: (task, command) => {
      if (!command.sessionId) {
        throw new DomainError("invalid_transition", "running task requires session id", {
          taskId: task.id,
        });
      }
      if (task.stackStatus !== "clean") {
        throw new DomainError("invalid_transition",
          `task stack is ${task.stackStatus}; must be clean to start running`,
          { taskId: task.id, stackStatus: task.stackStatus });
      }
      const attempt = task.runs.length + 1;
      const run: NodeRun = {
        id: `run-${task.id}-${attempt}`,
        taskId: task.id,
        attempt,
        providerType: command.providerType ?? "unknown",
        runtimeType: command.runtimeType ?? "unknown",
        runtimeSessionId: command.sessionId,
        ...(command.providerSessionRef ? { providerSessionRef: command.providerSessionRef } : {}),
        startedAt: command.now,
      };
      const patch: Partial<TaskNode> = { executionStatus: "running", sessionId: command.sessionId };
      if (command.workspaceId !== undefined) patch.workspaceId = command.workspaceId;
      return {
        patch,
        runEffect: { kind: "append", run },
      };
    },
  },
  "update-run": {
    from: ["running"],
    apply: (task, command) => {
      const hasRef = command.providerSessionRef !== undefined;
      const hasOffset = command.outputOffset !== undefined;
      if (!hasRef && !hasOffset) {
        throw new DomainError("invalid_transition", "update-run requires providerSessionRef or outputOffset", {
          taskId: task.id,
        });
      }
      const patch: { providerSessionRef?: string; outputOffset?: number } = {};
      if (hasRef) patch.providerSessionRef = command.providerSessionRef!;
      if (hasOffset) patch.outputOffset = command.outputOffset!;
      return {
        patch: {},
        runEffect: { kind: "patch-open-run", patch },
      };
    },
  },
  "complete-runtime": {
    from: ["running"],
    apply: (task, command) => {
      if (task.stackStatus !== "clean") {
        throw new DomainError(
          "invalid_transition",
          `task stack is ${task.stackStatus}; must be clean to complete runtime`,
          { taskId: task.id, stackStatus: task.stackStatus },
        );
      }
      return {
        patch: { executionStatus: "completed", artifacts: appendArtifacts(task, command) },
        runEffect: { kind: "close", reason: "completed" },
      };
    },
  },
  "start-finalization": {
    from: ["completed"],
    apply: () => ({ patch: { executionStatus: "finalizing" } }),
  },
  "open-review": {
    from: ["finalizing"],
    apply: (task, command) => ({
      patch: { executionStatus: "pr-open", artifacts: appendArtifacts(task, command) },
    }),
  },
  "start-quality-gate": {
    from: ["completed", "finalizing"],
    apply: () => ({ patch: { executionStatus: "quality-pending" } }),
  },
  "complete-quality-gate": {
    from: ["quality-pending"],
    apply: (task, command) => ({
      patch: {
        executionStatus: command.passed === false ? "needs-review" : "finalizing",
        artifacts: appendArtifacts(task, command),
      },
    }),
  },
  "start-ci-gate": {
    from: ["pr-open"],
    apply: () => ({ patch: { executionStatus: "ci-pending" } }),
  },
  "complete-ci-gate": {
    from: ["ci-pending"],
    apply: (task, command) => ({
      patch: { executionStatus: "pr-open", artifacts: appendArtifacts(task, command) },
    }),
  },
  "merge-task": {
    from: ["pr-open"],
    apply: () => ({ patch: { executionStatus: "merged" } }),
  },
  "complete-without-pr": {
    from: ["finalizing"],
    apply: () => ({ patch: { executionStatus: "merged" } }),
  },
  "merge-conflict": {
    from: ["pr-open", "finalizing", "ci-pending"],
    apply: (task, command) => ({
      patch: {
        executionStatus: "needs-review",
        artifacts: appendArtifacts(task, command),
      },
    }),
  },
  "cancel-task": {
    from: [
      "pending",
      "ready",
      "running",
      "completed",
      "finalizing",
      "quality-pending",
      "ci-pending",
      "pr-open",
      "merged",
      "failed",
      "needs-review",
    ],
    apply: () => ({
      patch: { executionStatus: "cancelled" },
      runEffect: { kind: "close", reason: "cancelled" },
    }),
  },
  "clear-session": {
    from: [
      "pending",
      "ready",
      "running",
      "completed",
      "finalizing",
      "quality-pending",
      "ci-pending",
      "pr-open",
      "merged",
      "failed",
      "needs-review",
      "cancelled",
    ],
    apply: () => ({
      patch: {},
      clearSession: true,
    }),
  },
  "recover-task": {
    from: ["ready", "running", "quality-pending", "ci-pending"],
    apply: (task, command) => {
      if (command.reason === "stream_idle_timeout") {
        const attempt = countStreamIdleAutoRecoveries(task.runs) + 1;
        const exhausted = task.artifacts.length === 0 && attempt > MAX_STREAM_IDLE_AUTO_RECOVERIES;
        return {
          patch: {
            executionStatus: exhausted
              ? "needs-review"
              : task.artifacts.length > 0
                ? "needs-review"
                : "pending",
          },
          clearSession: true,
          runEffect: {
            kind: "close",
            reason: exhausted ? "timeout" : "recovered",
            exitMetadata: {
              recoverySource: "stream_idle_timeout",
              streamIdleAutoRecoveryAttempt: attempt,
              streamIdleAutoRecoveryLimit: MAX_STREAM_IDLE_AUTO_RECOVERIES,
              streamIdleAutoRecovered: !exhausted,
              ...(exhausted ? { streamIdleAutoRecoveryExhausted: true } : {}),
            },
          },
        };
      }

      return {
        patch: { executionStatus: task.artifacts.length > 0 ? "needs-review" : "pending" },
        clearSession: true,
        runEffect: { kind: "close", reason: "recovered" },
      };
    },
  },
  "mark-interrupted": {
    from: ["running"],
    apply: () => ({
      patch: { executionStatus: "needs-review" },
      clearSession: true,
      runEffect: { kind: "close", reason: "interrupted" },
    }),
  },
  "fail-task": {
    from: ["pending", "ready", "running", "finalizing", "quality-pending", "ci-pending"],
    apply: () => ({
      patch: { executionStatus: "failed" },
      runEffect: { kind: "close", reason: "failed" },
    }),
  },
};

export function transitionTask(workflow: Workflow, command: TransitionCommand): Workflow {
  const task = workflow.graph[command.taskId];
  if (!task) {
    throw new DomainError("not_found", "task not found", { taskId: command.taskId });
  }

  if (command.expectedVersion !== undefined && command.expectedVersion !== task.version) {
    throw new DomainError("version_conflict", "task version does not match", {
      taskId: task.id,
      expectedVersion: command.expectedVersion,
      actualVersion: task.version,
    });
  }

  if (command.expectedSessionId !== undefined && command.expectedSessionId !== task.sessionId) {
    throw new DomainError("session_mismatch", "task session does not match", {
      taskId: task.id,
      expectedSessionId: command.expectedSessionId,
      actualSessionId: task.sessionId,
    });
  }

  const rule = TRANSITIONS[command.kind];
  if (!rule) {
    throw new DomainError("invalid_transition", "unknown transition kind", {
      taskId: task.id,
      kind: command.kind,
    });
  }
  if (!rule.from.includes(task.executionStatus)) {
    throw new DomainError("invalid_transition", "task status does not allow transition", {
      taskId: task.id,
      kind: command.kind,
      status: task.executionStatus,
      allowed: rule.from,
    });
  }

  const effect = rule.apply(task, command);
  const next = updateTask(task, command, effect);
  let graph = { ...workflow.graph, [task.id]: next };
  if (DEPENDENCY_BLOCKING_EXECUTION_STATUSES.has(next.executionStatus)) {
    graph = cascadeBlockedPendingDescendants(graph, next.id, command);
  }

  return {
    ...workflow,
    graph,
    status: deriveWorkflowStatus(graph),
    version: workflow.version + 1,
    updatedAt: command.now,
  };
}

function cascadeBlockedPendingDescendants(
  graph: Record<string, TaskNode>,
  blockedTaskId: string,
  command: TransitionCommand,
): Record<string, TaskNode> {
  let nextGraph = graph;
  const queue = [blockedTaskId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const task of Object.values(nextGraph)) {
      if (task.executionStatus !== "pending") continue;
      if (!task.dependsOn.includes(currentId)) continue;
      const isBlocked = task.dependsOn.some((depId) => {
        const dependency = nextGraph[depId];
        return dependency !== undefined && DEPENDENCY_BLOCKING_EXECUTION_STATUSES.has(dependency.executionStatus);
      });
      if (!isBlocked) continue;

      const cancelledTask = updateTask(task, command, {
        patch: { executionStatus: "cancelled" },
      });
      nextGraph = { ...nextGraph, [task.id]: cancelledTask };
      queue.push(task.id);
    }
  }

  return nextGraph;
}

function updateTask(task: TaskNode, command: TransitionCommand, effect: TransitionEffect): TaskNode {
  const updated: TaskNode = {
    ...task,
    ...effect.patch,
    version: task.version + 1,
    updatedAt: command.now,
  };

  if (effect.clearSession) delete updated.sessionId;

  if (effect.runEffect) {
    if (effect.runEffect.kind === "append") {
      updated.runs = appendRun(task.runs, effect.runEffect.run);
    } else if (effect.runEffect.kind === "close") {
      updated.runs = closeLatestRun(task.runs, effect.runEffect.reason, command.now, effect.runEffect.exitMetadata);
    } else {
      updated.runs = patchOpenRun(task.runs, effect.runEffect.patch);
    }
  }

  return updated;
}

function deriveWorkflowStatus(graph: Record<string, TaskNode>): Workflow["status"] {
  const tasks = Object.values(graph);
  if (tasks.every((task) => task.executionStatus === "cancelled")) return "cancelled";
  if (tasks.every((task) => TASK_WORKFLOW_COMPLETING_STATUSES.has(task.executionStatus))) {
    if (tasks.some((task) => task.executionStatus === "failed")) {
      return "failed";
    }
    return "completed";
  }
  return "active";
}
