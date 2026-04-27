import type { Session } from "@minions/shared";
import type { SidecarClient } from "../client.js";
import type { Rule } from "./index.js";

const RECENT_LAND_WINDOW_MS = 5 * 60 * 1000;
const nudged = new Map<string, number>();

function autoLandEnabled(): boolean {
  return process.env["MINIONS_SIDECAR_AUTO_LAND"] === "true";
}

async function recentLandIssued(slug: string, client: SidecarClient): Promise<boolean> {
  const events = await client.getAuditEvents(200);
  const cutoff = Date.now() - RECENT_LAND_WINDOW_MS;
  return events.some((ev) => {
    if (!ev.action.includes("land")) return false;
    if (ev.target?.id !== slug) return false;
    const t = Date.parse(ev.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
}

async function check(session: Session, client: SidecarClient): Promise<void> {
  if (session.status !== "completed") return;
  if (!session.pr || session.pr.state !== "open") return;

  const readiness = await client.getReadiness(session.slug);
  if (readiness.status !== "ready") return;

  if (await recentLandIssued(session.slug, client)) return;

  const last = nudged.get(session.slug);
  if (last && Date.now() - last < RECENT_LAND_WINDOW_MS) return;
  nudged.set(session.slug, Date.now());

  if (autoLandEnabled()) {
    client.log.info("ready to land — auto-landing", {
      rule: "landReady",
      slug: session.slug,
      pr: session.pr.number,
    });
    try {
      await client.postCommand({
        kind: "land",
        sessionSlug: session.slug,
        strategy: "squash",
      });
    } catch (err) {
      client.log.error("auto-land failed", {
        rule: "landReady",
        slug: session.slug,
        err: String(err),
      });
    }
    return;
  }

  client.log.info("session is ready to land — operator nudge", {
    rule: "landReady",
    slug: session.slug,
    pr: session.pr.number,
    url: session.pr.url,
  });
}

export const landReady: Rule = {
  id: "landReady",
  description:
    "Logs a nudge when a completed session with an open PR is ready to land. Auto-lands when MINIONS_SIDECAR_AUTO_LAND=true.",

  async onSessionUpdated(session, client) {
    await check(session, client);
  },

  async tick(client) {
    const sessions = await client.getSessions();
    for (const s of sessions) {
      if (s.status === "completed" && s.pr && s.pr.state === "open") {
        try {
          await check(s, client);
        } catch (err) {
          client.log.warn("landReady check failed", {
            rule: "landReady",
            slug: s.slug,
            err: String(err),
          });
        }
      }
    }
  },
};
