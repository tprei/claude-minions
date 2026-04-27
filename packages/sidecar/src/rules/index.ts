import type { AuditEvent, Session, TranscriptEvent } from "@minions/shared";
import type { SidecarClient } from "../client.js";
import { stuckWaitingInput } from "./stuckWaitingInput.js";
import { uncommittedCompleted } from "./uncommittedCompleted.js";
import { failedCiNoFix } from "./failedCiNoFix.js";
import { landReady } from "./landReady.js";
import { dagStaleReady } from "./dagStaleReady.js";

export interface Rule {
  id: string;
  description: string;
  init?(client: SidecarClient): void;
  onSessionUpdated?(session: Session, client: SidecarClient): Promise<void>;
  onTranscriptEvent?(slug: string, ev: TranscriptEvent, client: SidecarClient): Promise<void>;
  onAuditEvent?(ev: AuditEvent, client: SidecarClient): Promise<void>;
  tick?(client: SidecarClient): Promise<void>;
}

export const allRules: Rule[] = [
  stuckWaitingInput,
  uncommittedCompleted,
  failedCiNoFix,
  landReady,
  dagStaleReady,
];

export function selectRules(names: string[]): Rule[] {
  if (names.length === 1 && names[0] === "all") return allRules;
  const set = new Set(names);
  return allRules.filter((r) => set.has(r.id));
}
