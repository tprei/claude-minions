import type { Session } from "@minions/shared";
import type { SidecarClient } from "../client.js";
import type { Rule } from "./index.js";

export const FAILED_CI_NO_FIX_COOLDOWN_MS = 5 * 60 * 1000;

interface SpawnRecord {
  lastSpawnedAt: string;
}

const spawned = new Map<string, SpawnRecord>();

interface CiFailure {
  message: string;
  raisedAt: string;
}

function ciFailedFlag(session: Session): CiFailure | undefined {
  const flag = session.attention.find((a) => a.kind === "ci_failed");
  if (!flag) return undefined;
  return { message: flag.message, raisedAt: flag.raisedAt };
}

async function hasFixCiChild(session: Session, client: SidecarClient): Promise<boolean> {
  for (const childSlug of session.childSlugs) {
    try {
      const child = await client.getSession(childSlug);
      if (child.metadata?.["kind"] === "fix-ci") return true;
    } catch {
      // child fetch failed — treat as missing
    }
  }
  return false;
}

function isWithinCooldown(record: SpawnRecord, failureRaisedAt: string): boolean {
  const last = Date.parse(record.lastSpawnedAt);
  const failed = Date.parse(failureRaisedAt);
  if (!Number.isFinite(last) || !Number.isFinite(failed)) return true;
  return failed < last + FAILED_CI_NO_FIX_COOLDOWN_MS;
}

export const failedCiNoFix: Rule = {
  id: "failedCiNoFix",
  description:
    "When a session has an open PR with CI failed and no fix-CI child, spawn a fix-CI subsession. Re-spawns allowed for repeat failures past a 5-minute cooldown.",

  async onSessionUpdated(session, client) {
    if (session.pr && (session.pr.state === "closed" || session.pr.state === "merged")) {
      spawned.delete(session.slug);
      return;
    }
    if (!session.pr || session.pr.state !== "open") return;
    const failure = ciFailedFlag(session);
    if (!failure) return;

    const existing = spawned.get(session.slug);
    if (existing && isWithinCooldown(existing, failure.raisedAt)) return;

    if (await hasFixCiChild(session, client)) {
      spawned.set(session.slug, { lastSpawnedAt: new Date().toISOString() });
      return;
    }

    spawned.set(session.slug, { lastSpawnedAt: new Date().toISOString() });
    client.log.warn("CI failed with no fix-CI child — spawning sub-session", {
      rule: "failedCiNoFix",
      slug: session.slug,
      pr: session.pr.number,
    });

    try {
      const created = await client.createSession({
        mode: "task",
        parentSlug: session.slug,
        prompt:
          `CI is failing on PR #${session.pr.number} (${session.pr.url}).\n\n` +
          `Failure summary:\n${failure.message}\n\n` +
          `Investigate the failure, fix the underlying cause, and push a commit. ` +
          `Do not bypass hooks or skip checks.`,
        repoId: session.repoId,
        baseBranch: session.branch,
        metadata: { kind: "fix-ci", forSession: session.slug },
      });
      client.log.info("spawned fix-CI sub-session", {
        rule: "failedCiNoFix",
        slug: session.slug,
        childSlug: created.slug,
      });
    } catch (err) {
      spawned.delete(session.slug);
      client.log.error("failed to spawn fix-CI sub-session", {
        rule: "failedCiNoFix",
        slug: session.slug,
        err: String(err),
      });
    }
  },
};
