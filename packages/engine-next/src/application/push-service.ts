import type { WorkflowEvent } from "../domain/events.js";
import { TASK_TERMINAL_EXECUTION_STATUSES } from "../domain/types.js";
import type { PushSendResult, PushSender } from "../plugins/push-sender.js";
import type { PushSubscriptionRecord, SubscriptionRepository } from "./subscription-repository.js";
import type { WorkflowRepository } from "./repository.js";
import type { Logger } from "../observability/logger.js";

const TITLE_PERMISSION_NEEDED = "Permission needed";
const TITLE_TASK_ERROR = "Task error";
const TITLE_TASK_COMPLETE = "Task complete";
const TITLE_TASK_FAILED = "Task failed";
const TITLE_NEEDS_REVIEW = "Needs review";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

type NotifyCode = "perm" | "error" | "done" | "failed" | "review";

interface NotifyDecision {
  code: NotifyCode;
  taskId: string;
  title: string;
  body: string;
}

export interface PushPayload {
  tag: string;
  title: string;
  body: string;
  workflowId: string;
  taskId: string;
  code: NotifyCode;
  cursor: number;
  url: string;
}

export interface PushServiceDeps {
  workflowRepo: WorkflowRepository;
  subscriptions: SubscriptionRepository;
  sender: PushSender;
  signal: AbortSignal;
  log: Logger;
}

export class PushService {
  private readonly deps: PushServiceDeps;
  private readonly activeIterators = new Map<string, AsyncIterator<WorkflowEvent>>();

  constructor(deps: PushServiceDeps) {
    this.deps = deps;
    deps.signal.addEventListener("abort", () => {
      for (const iter of this.activeIterators.values()) {
        void iter.return?.();
      }
    });
  }

  attach(workflowId: string): void {
    if (this.activeIterators.has(workflowId)) return;
    // Set a placeholder so idempotent check passes before async consumer starts
    this.activeIterators.set(workflowId, null as unknown as AsyncIterator<WorkflowEvent>);
    void this.consume(workflowId);
  }

  detach(workflowId: string): void {
    const iter = this.activeIterators.get(workflowId);
    if (iter) {
      void iter.return?.();
    }
    this.activeIterators.delete(workflowId);
  }

  shouldNotify(event: WorkflowEvent): NotifyDecision | null {
    if (event.kind === "task-transitioned") {
      const { taskId, toExecutionStatus } = event.payload;
      if (!TASK_TERMINAL_EXECUTION_STATUSES.has(toExecutionStatus)) return null;

      let code: NotifyCode;
      let title: string;
      let suffix: string;

      if (toExecutionStatus === "completed" || toExecutionStatus === "pr-open" || toExecutionStatus === "merged") {
        code = "done";
        title = TITLE_TASK_COMPLETE;
        suffix = toExecutionStatus;
      } else if (toExecutionStatus === "failed" || toExecutionStatus === "cancelled") {
        code = "failed";
        title = TITLE_TASK_FAILED;
        suffix = toExecutionStatus;
      } else {
        code = "review";
        title = TITLE_NEEDS_REVIEW;
        suffix = toExecutionStatus;
      }

      return {
        code,
        taskId,
        title,
        body: `${truncate(taskId, 30)}: ${suffix}`,
      };
    }

    if (event.kind === "provider-event") {
      const { taskId, providerEvent } = event.payload;

      if (providerEvent.kind === "permission_request") {
        return {
          code: "perm",
          taskId,
          title: TITLE_PERMISSION_NEEDED,
          body: `${truncate(taskId, 30)}: ${providerEvent.tool}`,
        };
      }

      if (providerEvent.kind === "error" && !providerEvent.recoverable) {
        return {
          code: "error",
          taskId,
          title: TITLE_TASK_ERROR,
          body: `${truncate(taskId, 30)}: ${truncate(providerEvent.message, 60)}`,
        };
      }
    }

    return null;
  }

  buildPayload(workflowId: string, event: WorkflowEvent, decision: NotifyDecision): PushPayload {
    return {
      tag: `${workflowId}:${decision.taskId}:${decision.code}`,
      title: decision.title,
      body: decision.body,
      workflowId,
      taskId: decision.taskId,
      code: decision.code,
      cursor: event.cursor,
      url: `/workflows/${workflowId}?task=${decision.taskId}`,
    };
  }

  private async trySend(sub: PushSubscriptionRecord, payload: string, workflowId: string): Promise<void> {
    const result: PushSendResult = await this.deps.sender.send(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
    );
    if (!result.ok) {
      if (result.statusCode === 404 || result.statusCode === 410) {
        this.deps.log.info("push: removing stale subscription", { endpoint: sub.endpoint, statusCode: result.statusCode });
        await this.deps.subscriptions.remove(sub.endpoint, workflowId);
      } else {
        this.deps.log.error("push: send failed", { kind: "push-send-failed", workflowId, endpoint: sub.endpoint, statusCode: result.statusCode, error: result.error });
      }
    }
  }

  private async consume(workflowId: string): Promise<void> {
    // Live tail only — subscribe from current cursor so historic terminal events
    // do not re-notify on engine restart.
    const currentCursor = await this.deps.workflowRepo.latestCursor(workflowId);
    const iterable = this.deps.workflowRepo.subscribe(workflowId, currentCursor);
    const iter = iterable[Symbol.asyncIterator]();
    this.activeIterators.set(workflowId, iter);
    try {
      while (true) {
        if (this.deps.signal.aborted) break;
        const result = await iter.next();
        if (result.done) break;
        if (this.deps.signal.aborted) break;

        const event = result.value;
        const decision = this.shouldNotify(event);
        if (!decision) continue;

        const payload = this.buildPayload(workflowId, event, decision);
        const payloadStr = JSON.stringify(payload);
        const subs = await this.deps.subscriptions.listByWorkflow(workflowId);
        await Promise.allSettled(subs.map((sub) => this.trySend(sub, payloadStr, workflowId)));
      }
    } catch (err) {
      this.deps.log.error("push-service consumer error", { error: (err as Error).message });
    } finally {
      this.activeIterators.delete(workflowId);
    }
  }
}
