import type { PRSummary } from "@minions/shared";

export interface SessionStateUpdater {
  update(slug: string, patch: { baseBranch?: string }): void;
  setPr(slug: string, pr: PRSummary | null): void;
}
