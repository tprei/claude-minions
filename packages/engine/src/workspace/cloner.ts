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
    log.info("fetching existing bare clone", { repoId, barePath });
    const bareGit = simpleGit(barePath);
    // Bare clones created with `--bare` (vs `--mirror`) have no `+refs/heads/*:refs/heads/*`
    // refspec, so `fetch --all` only updates `FETCH_HEAD` and never advances local branches.
    // Set the mirror refspec then fetch so local `main` (and any other branch we resolve
    // baseSha against in addWorktree) always reflects origin.
    await bareGit.raw(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
    await bareGit.fetch(["--prune", "origin"]);
  } else {
    log.info("cloning bare repo", { repoId, remote, barePath });
    // `--mirror` sets up the proper refspec so future fetches advance local branches.
    await git.clone(remote, barePath, ["--mirror"]);
  }

  return barePath;
}
