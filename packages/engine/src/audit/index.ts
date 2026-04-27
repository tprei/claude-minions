import path from "node:path";
import type { AuditEvent } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { AuditRepo } from "../store/repos/auditRepo.js";
import { appendAuditLog } from "./log.js";

export interface AuditSubsystem {
  record: (actor: string, action: string, target?: { kind: string; id: string }, detail?: Record<string, unknown>) => void;
  list: (limit?: number) => AuditEvent[];
}

export function createAuditSubsystem(deps: SubsystemDeps): SubsystemResult<AuditSubsystem> {
  const repo = new AuditRepo(deps.db);
  const logPath = path.join(deps.workspaceDir, "audit", "audit.log");

  const api: AuditSubsystem = {
    record(actor, action, target, detail) {
      repo.record(actor, action, target, detail);
      const events = repo.list(1);
      const latest = events[0];
      if (latest) {
        appendAuditLog(logPath, latest).catch((e: unknown) => {
          deps.log.warn("audit log append failed", { error: (e as Error).message });
        });
      }
    },

    list(limit = 200) {
      return repo.list(limit);
    },
  };

  return { api };
}
