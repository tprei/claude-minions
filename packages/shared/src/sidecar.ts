export interface SidecarRuleState {
  ruleId: string;
  targetKind: string;
  targetId: string;
  lastAction?: string;
  attempts: number;
  cooldownExpiresAt?: string;
  lastInputHash?: string;
  lastObservedAt: string;
  updatedAt: string;
}
