import simpleGit from "simple-git";

export type CommitsAheadFn = (
  worktreePath: string,
  branch: string,
  baseBranch: string,
) => Promise<number>;

export const commitsAhead: CommitsAheadFn = async (worktreePath, branch, baseBranch) => {
  const git = simpleGit(worktreePath);
  const range = `${baseBranch}..${branch}`;
  const out = await git.raw(["rev-list", "--count", range]);
  const n = Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
};
