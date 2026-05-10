import { deriveEvents } from "../domain/events.js";
import type { WorkflowEvent } from "../domain/events.js";
import { DomainError } from "../domain/errors.js";
import type { Workflow } from "../domain/types.js";
import type { IdempotencyRecord, WorkflowRepository } from "./repository.js";
import {
  completeRestackOperation,
  markRestackConflict,
  requestRestack,
  startRestackOperation,
} from "./restack.js";
import type { CompleteRestackInput, RequestRestackInput } from "./restack.js";
import { transitionTask } from "./transitions.js";
import type { TransitionCommand } from "./transitions.js";

export type Command =
  | { kind: "transition-task"; workflowId: string; transition: TransitionCommand }
  | { kind: "request-restack"; workflowId: string; input: RequestRestackInput }
  | { kind: "start-restack"; workflowId: string; operationId: string; now: string }
  | { kind: "complete-restack"; workflowId: string; input: CompleteRestackInput }
  | { kind: "mark-restack-conflict"; workflowId: string; operationId: string; error: string; now: string };

export type CommandKind = Command["kind"];

export interface CommandResult {
  workflow: Workflow;
  events: WorkflowEvent[];
}

export interface CommandOptions {
  recoveryIdempotency?: IdempotencyRecord;
}

interface CommandRule<C extends Command = Command> {
  apply: (workflow: Workflow, command: C) => Workflow;
  events: (prev: Workflow, next: Workflow, command: C) => WorkflowEvent[];
}

const COMMANDS: { [K in Command["kind"]]: CommandRule<Extract<Command, { kind: K }>> } = {
  "transition-task": {
    apply: (workflow, command) => transitionTask(workflow, command.transition),
    events: (prev, next, command) =>
      deriveEvents(prev, next, command.transition.now, command.transition.kind),
  },
  "request-restack": {
    apply: (workflow, command) => requestRestack(workflow, command.input).workflow,
    events: (prev, next, command) => deriveEvents(prev, next, command.input.now),
  },
  "start-restack": {
    apply: (workflow, command) => startRestackOperation(workflow, command.operationId, command.now),
    events: (prev, next, command) => deriveEvents(prev, next, command.now),
  },
  "complete-restack": {
    apply: (workflow, command) => completeRestackOperation(workflow, command.input),
    events: (prev, next, command) => deriveEvents(prev, next, command.input.now),
  },
  "mark-restack-conflict": {
    apply: (workflow, command) =>
      markRestackConflict(workflow, command.operationId, command.error, command.now),
    events: (prev, next, command) => deriveEvents(prev, next, command.now),
  },
};

export async function applyCommand(
  repo: WorkflowRepository,
  command: Command,
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (command.kind === "request-restack") {
    const existing = await repo.lookupIdempotency(command.workflowId, command.input.idempotencyKey);
    if (existing !== undefined) {
      const workflow = await repo.get(command.workflowId);
      if (!workflow) {
        throw new DomainError("not_found", "workflow not found", { workflowId: command.workflowId });
      }
      return { workflow, events: [] };
    }
  }

  const workflow = await repo.get(command.workflowId);
  if (!workflow) {
    throw new DomainError("not_found", "workflow not found", { workflowId: command.workflowId });
  }

  const rule = COMMANDS[command.kind] as CommandRule;
  const next = rule.apply(workflow, command);
  const events = rule.events(workflow, next, command);

  const idempotency: IdempotencyRecord[] = [];

  if (command.kind === "request-restack") {
    const op = next.operations[command.input.operationId];
    if (op) {
      idempotency.push({ key: command.input.idempotencyKey, resultRef: op.id });
    }
  }

  if (options.recoveryIdempotency) {
    idempotency.push(options.recoveryIdempotency);
  }

  await repo.save(next, events, idempotency.length > 0 ? idempotency : undefined);

  return { workflow: next, events };
}
