import simpleGit from "simple-git";
import type { Logger } from "../logger.js";
import { EngineError } from "../errors.js";
import { gitAuthEnv } from "../ci/askpass.js";

export async function pushBranch(
  worktreePath: string,
  branch: string,
  log: Logger,
): Promise<void> {
  const git = simpleGit(worktreePath).env(gitAuthEnv());
  log.info("pushing branch to origin", { worktreePath, branch });
  try {
    await git.push(["-u", "--force-with-lease", "origin", branch]);
  } catch (err) {
    const message = (err as Error).message;
    throw new EngineError("upstream", `failed to push ${branch} to origin: ${message}`);
  }
}
