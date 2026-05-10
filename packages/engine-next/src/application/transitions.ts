import { DomainError } from "../domain/errors.js";
import { appendRun, closeLatestRun, patchOpenRun } from "../domain/runs.js";
import type { NodeRun, NodeRunTerminalReason } from "../domain/runs.js";
import type { Artifact, TaskExecutionStatus, TaskNode, Workflow } from "../domain/types.js";
import { TASK_WORKFLOW_COMPLETING_STATUSES } from "../domain/types.js";

export type TransitionKind =
  | "mark-ready"
  | "mark-running"
  | "update-run"
  | "complete-runtime"
  | "start-finalization"
  | "open-review"
  | "start-quality-gate"
  | "complete-quality-gate"
  | "start-ci-gate"
  | "complete-ci-gate"
  | "merge-task"
  | "merge-conflict"
  | "cancel-task"
  | "recover-task"
  | "mark-interrupted"
  | "fail-task";

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
    | { kind: "close"; reason: NodeRunTerminalReason }
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

const TRANSITIONS: Record<TransitionKind, TransitionRule> = {
  "mark-ready": {
    from: ["pending"],
    apply: () => ({ patch: { executionStatus: "ready" } }),
  },
  "mark-running": {
    from: ["ready", "needs-review"],
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
    apply: (task, command) => ({
      patch: { executionStatus: "completed", artifacts: appendArtifacts(task, command) },
      runEffect: { kind: "close", reason: "completed" },
    }),
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
    from: ["pending", "ready", "running", "finalizing", "quality-pending", "ci-pending", "needs-review"],
    apply: () => ({
      patch: { executionStatus: "cancelled" },
      runEffect: { kind: "close", reason: "cancelled" },
    }),
  },
  "recover-task": {
    from: ["ready", "running", "quality-pending", "ci-pending"],
    apply: (task) => ({
      patch: { executionStatus: task.artifacts.length > 0 ? "needs-review" : "pending" },
      clearSession: true,
      runEffect: { kind: "close", reason: "recovered" },
    }),
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
  const graph = { ...workflow.graph, [task.id]: next };

  return {
    ...workflow,
    graph,
    status: deriveWorkflowStatus(graph),
    version: workflow.version + 1,
    updatedAt: command.now,
  };
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
      updated.runs = closeLatestRun(task.runs, effect.runEffect.reason, command.now);
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
