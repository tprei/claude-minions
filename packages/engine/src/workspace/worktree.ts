import path from "node:path";
import { simpleGit } from "simple-git";
import type { Logger } from "../logger.js";
import { ensureDir, pathExists } from "../util/fs.js";

function barePath(reposDir: string, repoId: string): string {
  return path.join(reposDir, `${repoId}.git`);
}

export async function addWorktree(
  reposDir: string,
  worktreeRoot: string,
  repoId: string,
  slug: string,
  base: string | undefined,
  log: Logger,
): Promise<{ worktreePath: string; branch: string; baseSha: string }> {
  const bare = barePath(reposDir, repoId);
  const bareGit = simpleGit(bare);
  const branch = `minions/${slug}`;

  const resolvedBase = base ?? (await getDefaultBranch(bareGit));
  const baseSha = (await bareGit.revparse([resolvedBase])).trim();

  const worktreePath = path.join(worktreeRoot, slug);
  log.info("adding worktree", { slug, branch, resolvedBase, worktreePath });

  await bareGit.raw(["worktree", "add", "-b", branch, worktreePath, baseSha]);

  return { worktreePath, branch, baseSha };
}

export async function removeWorktree(
  reposDir: string,
  worktreeRoot: string,
  repoId: string,
  slug: string,
  log: Logger,
): Promise<void> {
  const bare = barePath(reposDir, repoId);
  const worktreePath = path.join(worktreeRoot, slug);
  const branch = `minions/${slug}`;

  if (!(await pathExists(bare))) {
    log.warn("bare repo not found, skipping worktree remove", { repoId, slug });
    return;
  }

  const bareGit = simpleGit(bare);

  if (await pathExists(worktreePath)) {
    log.info("removing worktree", { slug, worktreePath });
    try {
      await bareGit.raw(["worktree", "remove", "--force", worktreePath]);
    } catch (err) {
      log.warn("worktree remove failed, pruning", { slug, err: String(err) });
      await bareGit.raw(["worktree", "prune"]);
    }
  }

  try {
    await bareGit.raw(["branch", "-D", branch]);
  } catch {
    log.warn("branch delete failed (may not exist)", { branch });
  }
}

export async function workInWorktree<T>(
  reposDir: string,
  worktreeRoot: string,
  repoId: string,
  slug: string,
  fn: (git: ReturnType<typeof simpleGit>) => Promise<T>,
): Promise<T> {
  const worktreePath = path.join(worktreeRoot, slug);
  const git = simpleGit(worktreePath);
  return fn(git);
}

async function getDefaultBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    const result = await git.raw(["symbolic-ref", "--short", "HEAD"]);
    return result.trim();
  } catch {
    return "main";
  }
}

export async function initScratchRepo(scratchPath: string, slug: string, log: Logger): Promise<void> {
  log.info("initializing scratch repo", { slug, scratchPath });
  await ensureDir(scratchPath);
  const git = simpleGit(scratchPath);
  await git.init();
  await git.addConfig("user.email", "minions@localhost");
  await git.addConfig("user.name", "Minions");
  await git.raw(["commit", "--allow-empty", "-m", "init"]);
}
