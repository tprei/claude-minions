import type { AuditEvent } from "@minions/shared";
import { appendJsonl } from "../util/fs.js";

export async function appendAuditLog(logPath: string, event: AuditEvent): Promise<void> {
  await appendJsonl(logPath, event);
}
