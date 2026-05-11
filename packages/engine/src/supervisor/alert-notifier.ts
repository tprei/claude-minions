import type { Alert, AlertSubscription } from "./alert.js";
import type { AlertRepo, AlertSubscriptionRepo } from "./alert-repo.js";
import type { PushSender } from "../plugins/push-sender.js";
import type { Logger } from "../observability/logger.js";

export class AlertNotifier {
  private log: Logger | undefined;

  constructor(
    private readonly alertRepo: AlertRepo,
    private readonly subRepo: AlertSubscriptionRepo,
    private readonly sender: PushSender | undefined,
  ) {}

  attachLogger(log: Logger): void {
    this.log = log;
  }

  async fire(alert: Alert): Promise<void> {
    this.alertRepo.insert(alert);
    this.log?.warn(alert.message, {
      kind: "alert",
      alertId: alert.id,
      alertKind: alert.kind,
      severity: alert.severity,
      workflowId: alert.workflowId,
      taskId: alert.taskId,
      ...alert.detail,
    });
    if (this.sender === undefined) return;
    const subs = this.subRepo.list();
    if (subs.length === 0) return;
    const payload = JSON.stringify({
      type: "alert",
      id: alert.id,
      kind: alert.kind,
      severity: alert.severity,
      message: alert.message,
      timestamp: alert.timestamp,
      workflowId: alert.workflowId,
      taskId: alert.taskId,
    });
    await Promise.allSettled(subs.map((sub) => this.sendOne(sub, payload)));
  }

  private async sendOne(sub: AlertSubscription, payload: string): Promise<void> {
    if (this.sender === undefined) return;
    const result = await this.sender.send({ endpoint: sub.endpoint, keys: sub.keys }, payload);
    if (!result.ok) {
      if (result.statusCode === 404 || result.statusCode === 410) {
        this.subRepo.remove(sub.endpoint);
      } else {
        this.log?.error("alert: push send failed", {
          kind: "alert-send-failed",
          endpoint: sub.endpoint,
          statusCode: result.statusCode,
          error: result.error?.message,
        });
      }
    }
  }
}
