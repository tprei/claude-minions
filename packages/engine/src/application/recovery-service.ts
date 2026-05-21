import { DomainError } from "../domain/errors.js";
import type { Artifact, Workflow } from "../domain/types.js";
import type { Command, CommandResult } from "./commands.js";
import { applyCommand } from "./commands.js";
import type {
  GraphOperationRecoveryAction,
  RecoveryAction,
  RecoveryOptions,
  TaskRecoveryAction,
} from "./recovery.js";
import { planRecovery } from "./recovery.js";
import type { IdempotencyRecord, WorkflowRepository } from "./repository.js";
import type { RestackExecutor } from "./restack-executor.js";
import { planRestack } from "./restack.js";
import type { RuntimeBackend } from "../plugins/runtime-backend.js";
import type { TransitionCommand, TransitionKind } from "./transitions.js";
import type { Logger } from "../observability/logger.js";

export interface RecoveryService {
  scan(workflowId: string, options: RecoveryOptions): Promise<CommandResult[]>;
}

interface ServiceDeps {
  repo: WorkflowRepository;
  executor: RestackExecutor;
  runtime: RuntimeBackend;
  now: () => string;
  log: Logger;
}

interface DispatchPlan {
  key: string;
  run: (deps: ServiceDeps) => Promise<CommandResult | null>;
}

type ActionRule<A extends RecoveryAction> = (workflow: Workflow, action: A) => DispatchPlan | null;

const TASK_TRANSITION_BY_ACTION: { [K in TaskRecoveryAction["kind"]]?: TransitionKind } = {
  "recover-task": "recover-task",
  "interrupt-task": "mark-interrupted",
};

const taskActionRule: ActionRule<TaskRecoveryAction> = (workflow, action) => {
  const task = workflow.graph[action.taskId];
  if (!task) return null;

  const planKey = taskRecoveryKey(workflow.id, task, action);

  if (action.kind === "stop-runtime") {
    return {
      key: planKey,
      run: async (deps) => {
        deps.log.info("recovery action", { kind: "recovery-action", action: action.kind, workflowId: workflow.id, taskId: action.taskId, planKey });
        if (task.executionStatus !== "cancelled") {
          await applyCommand(deps.repo, {
            kind: "transition-task",
            workflowId: workflow.id,
            transition: {
              kind: "cancel-task",
              taskId: action.taskId,
              now: deps.now(),
              ...(action.sessionId ? { expectedSessionId: action.sessionId } : {}),
            },
          });
        }

        if (action.sessionId) {
          await deps.runtime.stop(action.sessionId);
        }

        return applyCommand(
          deps.repo,
          {
            kind: "transition-task",
            workflowId: workflow.id,
            transition: {
              kind: "clear-session",
              taskId: action.taskId,
              now: deps.now(),
              ...(action.sessionId ? { expectedSessionId: action.sessionId } : {}),
            },
          },
          {
            recoveryIdempotency: {
              key: planKey,
              resultRef: `recovery:${action.kind}:${action.taskId}`,
            },
          },
        );
      },
    };
  }

  const transitionKind = TASK_TRANSITION_BY_ACTION[action.kind];
  if (transitionKind === undefined) return null;

  return {
    key: planKey,
    run: async (deps) => {
      deps.log.info("recovery action", { kind: "recovery-action", action: action.kind, workflowId: workflow.id, taskId: action.taskId, planKey });
      const recoveryRecord: IdempotencyRecord = {
        key: planKey,
        resultRef: `recovery:${action.kind}:${action.taskId}`,
      };

      const transition: TransitionCommand = { kind: transitionKind, taskId: action.taskId, now: deps.now() };
      if (action.sessionId) transition.expectedSessionId = action.sessionId;

      const command: Command = {
        kind: "transition-task",
        workflowId: workflow.id,
        transition,
      };

      return applyCommand(deps.repo, command, { recoveryIdempotency: recoveryRecord });
    },
  };
};

const resumeOperationRule: ActionRule<GraphOperationRecoveryAction> = (workflow, action) => {
  const operation = workflow.operations[action.operationId];
  if (!operation) return null;

  const planKey = `recovery:${workflow.id}:${action.operationId}:resume:${operation.attempt}`;

  return {
    key: planKey,
    run: async (deps) => {
      deps.log.info("recovery action", { kind: "recovery-action", action: action.kind, workflowId: workflow.id, operationId: action.operationId, planKey });
      let current = workflow;

      if (operation.status === "pending") {
        // Intermediate start-restack calls don't need recovery idempotency — already idempotent against workflow state.
        const started = await applyCommand(deps.repo, {
          kind: "start-restack",
          workflowId: workflow.id,
          operationId: action.operationId,
          now: deps.now(),
        });
        current = started.workflow;
      }

      const running = current.operations[action.operationId];
      if (!running || running.status !== "running") return null;

      const plan = planRestack(current, running.targetNodeId);
      const outcome = await deps.executor.execute(plan, running);

      const recoveryRecord: IdempotencyRecord = {
        key: planKey,
        resultRef: `recovery:resume-graph-operation:${action.operationId}`,
      };

      return outcome.kind === "completed"
        ? applyCommand(
            deps.repo,
            {
              kind: "complete-restack",
              workflowId: workflow.id,
              input: {
                operationId: action.operationId,
                artifactsByTaskId: outcome.artifactsByTaskId,
                now: deps.now(),
              },
            },
            { recoveryIdempotency: recoveryRecord },
          )
        : applyCommand(
            deps.repo,
            {
              kind: "mark-restack-conflict",
              workflowId: workflow.id,
              operationId: action.operationId,
              error: outcome.error,
              now: deps.now(),
            },
            { recoveryIdempotency: recoveryRecord },
          );
    },
  };
};

const probeGateRule: ActionRule<TaskRecoveryAction> = (workflow, action) => {
  if (action.kind !== "probe-gate") return null;
  const task = workflow.graph[action.taskId];
  if (!task) return null;

  const planKey = `recovery:${workflow.id}:${action.taskId}:probe-gate:version:${task.version}`;

  return {
    key: planKey,
    run: async (deps) => {
      deps.log.info("recovery action", { kind: "recovery-action", action: action.kind, workflowId: workflow.id, taskId: action.taskId, planKey });
      const recoveryRecord: IdempotencyRecord = {
        key: planKey,
        resultRef: `recovery:probe-gate:${action.taskId}`,
      };

      if (task.executionStatus === "quality-pending") {
        const artifact: Artifact = {
          kind: "quality-report",
          ref: JSON.stringify({
            overallStatus: "failed",
            checks: [],
            ranAt: deps.now(),
            reason: "stale-recovery",
          }),
          producedBy: "recovery",
          createdAt: deps.now(),
        };

        return applyCommand(
          deps.repo,
          {
            kind: "transition-task",
            workflowId: workflow.id,
            transition: {
              kind: "complete-quality-gate",
              taskId: action.taskId,
              passed: false,
              artifacts: [artifact],
              now: deps.now(),
            },
          },
          { recoveryIdempotency: recoveryRecord },
        );
      }

      const artifact: Artifact = {
        kind: "ci-report",
        ref: JSON.stringify({
          overallStatus: "failed",
          checks: [],
          ranAt: deps.now(),
          reason: "stale-recovery",
        }),
        producedBy: "recovery",
        createdAt: deps.now(),
      };

      return applyCommand(
        deps.repo,
        {
          kind: "transition-task",
          workflowId: workflow.id,
          transition: {
            kind: "merge-conflict",
            taskId: action.taskId,
            artifacts: [artifact],
            reason: "ci_stale_recovery",
            now: deps.now(),
          },
        },
        { recoveryIdempotency: recoveryRecord },
      );
    },
  };
};

const ACTION_RULES: { [K in RecoveryAction["kind"]]: ActionRule<Extract<RecoveryAction, { kind: K }>> } = {
  "recover-task": taskActionRule,
  "interrupt-task": taskActionRule,
  "stop-runtime": taskActionRule,
  "probe-gate": probeGateRule as ActionRule<Extract<RecoveryAction, { kind: "probe-gate" }>>,
  "operator-review": () => null,
  "resume-graph-operation": resumeOperationRule,
};

export function createRecoveryService(
  repo: WorkflowRepository,
  executor: RestackExecutor,
  runtime: RuntimeBackend,
  now: () => string,
  log: Logger,
): RecoveryService {
  const deps: ServiceDeps = { repo, executor, runtime, now, log };

  return {
    async scan(workflowId, options) {
      const workflow = await repo.get(workflowId);
      if (!workflow) {
        throw new DomainError("not_found", "workflow not found", { workflowId });
      }

      const results: CommandResult[] = [];

      for (const action of planRecovery(workflow, options)) {
        const current = await repo.get(workflowId);
        if (!current) {
          throw new DomainError("not_found", "workflow not found", { workflowId });
        }
        try {
          const result = await dispatchAction(deps, current, action);
          if (result !== null) results.push(result);
        } catch (err) {
          if (isStaleRecoveryRace(err)) continue;
          throw err;
        }
      }

      return results;
    },
  };
}

async function dispatchAction(
  deps: ServiceDeps,
  workflow: Workflow,
  action: RecoveryAction,
): Promise<CommandResult | null> {
  const rule = ACTION_RULES[action.kind] as ActionRule<RecoveryAction>;
  const plan = rule(workflow, action);
  if (!plan) return null;

  const existing = await deps.repo.lookupIdempotency(workflow.id, plan.key);
  if (existing !== undefined) return null;

  return plan.run(deps);
}

function taskRecoveryKey(workflowId: string, task: Workflow["graph"][string], action: TaskRecoveryAction): string {
  const discriminator = action.sessionId !== undefined
    ? `session:${action.sessionId}`
    : `version:${task.version}`;
  return `recovery:${workflowId}:${action.taskId}:${action.kind}:${discriminator}`;
}

function isStaleRecoveryRace(err: unknown): boolean {
  return err instanceof DomainError &&
    (err.code === "session_mismatch" || err.code === "invalid_transition");
}
