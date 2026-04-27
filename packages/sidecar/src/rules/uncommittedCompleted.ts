import type { Session } from "@minions/shared";
import type { SidecarClient } from "../client.js";
import type { Rule } from "./index.js";

const handled = new Set<string>();

function looksDirty(session: Session): boolean {
  const meta = session.metadata ?? {};
  if (meta["worktreeDirty"] === true) return true;
  if (typeof meta["uncommittedFiles"] === "number" && (meta["uncommittedFiles"] as number) > 0) {
    return true;
  }
  return false;
}

export const uncommittedCompleted: Rule = {
  id: "uncommittedCompleted",
  description:
    "Backstop: when a session completes with worktree changes uncommitted, force autoCommitOnCompletion on.",

  async onSessionUpdated(session, client) {
    if (session.status !== "completed") return;
    if (handled.has(session.slug)) return;
    if (!looksDirty(session)) return;
    handled.add(session.slug);

    client.log.warn("session completed with uncommitted worktree changes", {
      rule: "uncommittedCompleted",
      slug: session.slug,
    });

    try {
      await client.patchRuntimeConfig({ autoCommitOnCompletion: true });
    } catch (err) {
      client.log.error("failed to bump autoCommitOnCompletion", {
        rule: "uncommittedCompleted",
        err: String(err),
      });
    }
  },
};
