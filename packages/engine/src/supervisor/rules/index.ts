import type { LogRecord } from "../../observability/types.js";
import type { WorkflowRepository } from "../../application/repository.js";
import type { Alert, AlertKind } from "../alert.js";
import type { SupervisorState } from "../state.js";

import { mergeInconsistentRule } from "./merge-inconsistent.js";
import { pushFailuresSpikeRule } from "./push-failures-spike.js";
import { bootRecoveryFailedRule } from "./boot-recovery-failed.js";
import { orchestratorSilentRule } from "./orchestrator-silent.js";
import { ciExhaustedRule } from "./ci-exhausted.js";

export type { AlertKind };

export interface AnomalyRuleContext {
  now(): number;
  fireAlert(alert: Omit<Alert, "id" | "timestamp">): void;
  state: SupervisorState;
  workflowRepo: WorkflowRepository;
}

export interface AnomalyRule {
  readonly id: AlertKind;
  onLogRecord?(record: LogRecord, ctx: AnomalyRuleContext): void;
  onScan?(ctx: AnomalyRuleContext): void | Promise<void>;
}

export const ALL_RULES: AnomalyRule[] = [
  mergeInconsistentRule,
  pushFailuresSpikeRule,
  bootRecoveryFailedRule,
  orchestratorSilentRule,
  ciExhaustedRule,
];
