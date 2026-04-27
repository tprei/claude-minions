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
    await bareGit.fetch(["--all"]);
  } else {
    log.info("cloning bare repo", { repoId, remote, barePath });
    await git.clone(remote, barePath, ["--bare"]);
  }

  return barePath;
}
