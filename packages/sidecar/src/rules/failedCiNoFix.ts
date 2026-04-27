import type { Session } from "@minions/shared";
import type { SidecarClient } from "../client.js";
import type { Rule } from "./index.js";

const spawned = new Set<string>();

function ciFailedFlag(session: Session): string | undefined {
  const flag = session.attention.find((a) => a.kind === "ci_failed");
  return flag?.message;
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

export const failedCiNoFix: Rule = {
  id: "failedCiNoFix",
  description:
    "When a session has an open PR with CI failed and no fix-CI child, spawn a fix-CI subsession.",

  async onSessionUpdated(session, client) {
    if (!session.pr || session.pr.state !== "open") return;
    const failure = ciFailedFlag(session);
    if (!failure) return;
    if (spawned.has(session.slug)) return;
    if (await hasFixCiChild(session, client)) {
      spawned.add(session.slug);
      return;
    }

    spawned.add(session.slug);
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
          `Failure summary:\n${failure}\n\n` +
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
