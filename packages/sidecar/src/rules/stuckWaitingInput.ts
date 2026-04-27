import type { Session } from "@minions/shared";
import type { SidecarClient } from "../client.js";
import type { Rule } from "./index.js";

const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const POKED_FLAG = "sidecarPokedAt";

const poked = new Map<string, number>();

function lastTurnAt(session: Session): number {
  const t = session.lastTurnAt ?? session.startedAt ?? session.updatedAt;
  return t ? Date.parse(t) : Number.NaN;
}

async function check(session: Session, client: SidecarClient): Promise<void> {
  if (session.status !== "waiting_input") return;
  const last = lastTurnAt(session);
  if (!Number.isFinite(last)) return;
  const idleMs = Date.now() - last;
  if (idleMs < STUCK_THRESHOLD_MS) return;

  if (typeof session.metadata?.[POKED_FLAG] === "string") return;
  if (poked.has(session.slug)) return;
  poked.set(session.slug, Date.now());

  client.log.warn("stuck waiting_input — poking session", {
    rule: "stuckWaitingInput",
    slug: session.slug,
    idleMs,
  });

  await client.postCommand({
    kind: "reply",
    sessionSlug: session.slug,
    text:
      "You have been waiting on operator input for over 10 minutes. " +
      "If you can proceed without more input, do so; otherwise, write a brief summary and stop.",
  });
}

export const stuckWaitingInput: Rule = {
  id: "stuckWaitingInput",
  description: "Pokes sessions stuck in waiting_input for more than 10 minutes.",

  async onSessionUpdated(session, client) {
    await check(session, client);
  },

  async tick(client) {
    const sessions = await client.getSessions();
    for (const s of sessions) {
      if (s.status === "waiting_input") {
        await check(s, client);
      }
    }
  },
};
