import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { LogRecord } from "../observability/types.js";
import type { Sink } from "../observability/sinks.js";
import type { Logger } from "../observability/logger.js";
import type { WorkflowRepository } from "../application/repository.js";
import type { PushSender } from "../plugins/push-sender.js";
import type { Alert } from "./alert.js";
import { AuditRepo } from "./audit-repo.js";
import { AlertRepo, AlertSubscriptionRepo } from "./alert-repo.js";
import { AuditProjector } from "./audit-projector.js";
import { AlertNotifier } from "./alert-notifier.js";
import { ScanLoop } from "./scan-loop.js";
import { SupervisorState } from "./state.js";
import { ALL_RULES } from "./rules/index.js";
import type { AnomalyRule, AnomalyRuleContext } from "./rules/index.js";

export { SupervisorState } from "./state.js";

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_DEDUPE_COOLDOWN_MS = 5 * 60 * 1000;

export interface SupervisorConfig {
  db: Database.Database;
  sender?: PushSender;
  scanIntervalMs?: number;
  dedupeCooldownMs?: number;
  rules?: AnomalyRule[];
  now?: () => number;
  nowIso?: () => string;
}

export interface Supervisor {
  readonly sink: Sink;
  attachLogger(log: Logger): void;
  attachRepo(repo: WorkflowRepository): void;
  start(): void;
  stop(): Promise<void>;
}

export interface SupervisorWithRepos extends Supervisor {
  auditRepo: AuditRepo;
  alertRepo: AlertRepo;
  subRepo: AlertSubscriptionRepo;
}

export function createSupervisor(config: SupervisorConfig): SupervisorWithRepos {
  const now = config.now ?? (() => Date.now());
  const nowIso = config.nowIso ?? (() => new Date().toISOString());
  const dedupeCooldownMs = config.dedupeCooldownMs ?? DEFAULT_DEDUPE_COOLDOWN_MS;
  const rules = config.rules ?? ALL_RULES;

  const auditRepo = new AuditRepo(config.db);
  const alertRepo = new AlertRepo(config.db);
  const subRepo = new AlertSubscriptionRepo(config.db);

  const projector = new AuditProjector(auditRepo);
  const notifier = new AlertNotifier(alertRepo, subRepo, config.sender);

  const state = new SupervisorState();
  let workflowRepo: WorkflowRepository | undefined;
  let log: Logger | undefined;

  const fireAlert = (partial: Omit<Alert, "id" | "timestamp">): void => {
    const dedupeKey = `${partial.kind}:${partial.workflowId ?? ""}:${partial.taskId ?? ""}`;
    const lastFired = state.recentAlerts.get(dedupeKey);
    if (lastFired !== undefined && now() - lastFired < dedupeCooldownMs) return;
    state.recentAlerts.set(dedupeKey, now());
    const alert: Alert = {
      id: randomUUID(),
      timestamp: nowIso(),
      ...partial,
    };
    notifier.fire(alert).catch((err: unknown) => {
      log?.error("supervisor: notifier.fire failed, alert may be lost", {
        kind: "supervisor-error",
        alertKind: alert.kind,
        alertId: alert.id,
        error: (err as Error).message,
      });
      state.recentAlerts.delete(dedupeKey);
    });
  };

  const makeCtx = (): AnomalyRuleContext => ({
    now,
    fireAlert,
    state,
    workflowRepo: workflowRepo!,
  });

  const onRecord = (record: LogRecord): void => {
    projector.project(record);
    const ctx = makeCtx();
    for (const rule of rules) {
      if (rule.onLogRecord) {
        try {
          rule.onLogRecord(record, ctx);
        } catch {
          // rule errors must never crash the logger pipeline
        }
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (workflowRepo === undefined) return;
    const ctx = makeCtx();
    for (const rule of rules) {
      if (rule.onScan) {
        try {
          await rule.onScan(ctx);
        } catch {
          // per-rule errors are swallowed to keep the scan loop alive
        }
      }
    }
  };

  const scanLoop = new ScanLoop(tick, config.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);

  const sink: Sink = {
    write(record: LogRecord): void {
      if (record["kind"] === "alert") return;
      onRecord(record);
    },
  };

  return {
    sink,
    auditRepo,
    alertRepo,
    subRepo,
    attachLogger(l: Logger): void {
      log = l;
      notifier.attachLogger(log);
    },
    attachRepo(repo: WorkflowRepository): void {
      workflowRepo = repo;
    },
    start(): void {
      scanLoop.start();
    },
    async stop(): Promise<void> {
      await scanLoop.stop();
    },
  };
}
