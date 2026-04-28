import path from "node:path";
import { simpleGit } from "simple-git";
import type { Logger } from "../logger.js";
import { pathExists } from "../util/fs.js";

export async function ensureBareClone(
  repoId: string,
  remote: string,
  reposDir: string,
  log: Logger,
): Promise<string> {
  const barePath = path.join(reposDir, `${repoId}.git`);
  const git = simpleGit();

  if (await pathExists(barePath)) {
    // Targeted fetch happens per-session in addWorktree (force-fetch the requested
    // baseBranch) — that way we never touch refs/heads/minions/* branches that are
    // currently checked out by other worktrees, which git refuses to update.
    log.info("bare clone present, deferring fetch to addWorktree", { repoId, barePath });
  } else {
    log.info("cloning bare repo", { repoId, remote, barePath });
    // `--mirror` would set up `+refs/heads/*:refs/heads/*` automatically, but that
    // refspec collides with checked-out worktree branches on later fetches. Plain
    // `--bare` keeps the bare clean; addWorktree fetches just the baseBranch on demand.
    await git.clone(remote, barePath, ["--bare"]);
  }

  return barePath;
}
