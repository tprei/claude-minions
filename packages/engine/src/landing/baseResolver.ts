import simpleGit from "simple-git";
import type { EngineContext } from "../context.js";
import type { DagRepo } from "../dag/model.js";
import type { Logger } from "../logger.js";
import type { SessionStateUpdater } from "./sessionStateUpdater.js";

export type BranchExistsFn = (args: {
  worktreePath: string;
  branch: string;
}) => Promise<boolean>;

export type RebaseOntoFn = (args: {
  worktreePath: string;
  branch: string;
}) => Promise<void>;

export const defaultBranchExists: BranchExistsFn = async ({ worktreePath, branch }) => {
  const git = simpleGit(worktreePath);
  try {
    const out = await git.raw(["ls-remote", "--exit-code", "--heads", "origin", branch]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
};

export const defaultRebaseOnto: RebaseOntoFn = async ({ worktreePath, branch }) => {
  const git = simpleGit(worktreePath);
  await git.fetch("origin", branch);
  try {
    await git.rebase([`origin/${branch}`]);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("conflict") || message.includes("CONFLICT")) {
      await git.rebase(["--abort"]).catch(() => {});
      throw new Error(`rebase conflict: ${message}`);
    }
    throw err;
  }
};

export type LiveBaseReason =
  | "ok"
  | "ancestor-fallback"
  | "dag-base-fallback"
  | "default-fallback";

export interface LiveBaseResult {
  oldBase: string;
  newBase: string;
  changed: boolean;
  reason: LiveBaseReason;
}

export interface ResolveLiveBaseDeps {
  ctx: EngineContext;
  dagRepo: DagRepo;
  branchExists: BranchExistsFn;
  log: Logger;
}

export async function resolveLiveBase(
  slug: string,
  deps: ResolveLiveBaseDeps,
): Promise<LiveBaseResult> {
  const { ctx, dagRepo, branchExists, log } = deps;
  const session = ctx.sessions.get(slug);
  if (!session?.worktreePath) {
    const intended = session?.baseBranch ?? "main";
    return { oldBase: intended, newBase: intended, changed: false, reason: "ok" };
  }
  const intended = session.baseBranch ?? "main";
  const worktreePath = session.worktreePath;

  if (await branchExists({ worktreePath, branch: intended })) {
    return { oldBase: intended, newBase: intended, changed: false, reason: "ok" };
  }

  log.warn("session baseBranch missing on origin, walking dependency chain", {
    slug,
    intendedBase: intended,
  });

  const dagNode = dagRepo.getNodeBySession(slug);
  const dag = dagRepo.byNodeSession(slug);

  if (dag && dagNode) {
    const visited = new Set<string>();
    const queue: string[] = [...dagNode.dependsOn];
    while (queue.length) {
      const depId = queue.shift()!;
      if (visited.has(depId)) continue;
      visited.add(depId);
      const depNode = dagRepo.getNode(depId);
      if (!depNode) continue;
      let depBranch = depNode.branch;
      if (depNode.sessionSlug) {
        const depSession = ctx.sessions.get(depNode.sessionSlug);
        depBranch = depSession?.branch ?? depBranch;
      }
      if (depBranch && (await branchExists({ worktreePath, branch: depBranch }))) {
        return {
          oldBase: intended,
          newBase: depBranch,
          changed: depBranch !== intended,
          reason: "ancestor-fallback",
        };
      }
      queue.push(...depNode.dependsOn);
    }
    const dagBase = dag.baseBranch ?? "main";
    return {
      oldBase: intended,
      newBase: dagBase,
      changed: intended !== dagBase,
      reason: "dag-base-fallback",
    };
  }

  return {
    oldBase: intended,
    newBase: "main",
    changed: intended !== "main",
    reason: "default-fallback",
  };
}

export interface ApplyLiveBaseDeps {
  ctx: EngineContext;
  dagRepo: DagRepo;
  log: Logger;
  sessionRepo: SessionStateUpdater | null;
  branchExists: BranchExistsFn;
  rebaseOnto: RebaseOntoFn;
}

export async function applyLiveBase(
  slug: string,
  deps: ApplyLiveBaseDeps,
): Promise<LiveBaseResult> {
  const { ctx, dagRepo, log, sessionRepo, branchExists, rebaseOnto } = deps;

  const result = await resolveLiveBase(slug, { ctx, dagRepo, branchExists, log });
  if (!result.changed) return result;

  ctx.audit.record(
    "system",
    "landing.base.resolved",
    { kind: "session", id: slug },
    { oldBase: result.oldBase, newBase: result.newBase, reason: result.reason },
  );

  if (sessionRepo) {
    sessionRepo.update(slug, { baseBranch: result.newBase });
  }

  const dagNode = dagRepo.getNodeBySession(slug);
  if (dagNode) {
    try {
      dagRepo.updateNode(dagNode.id, { baseBranch: result.newBase });
    } catch (err) {
      log.warn("failed to update dag node base after re-resolution", {
        slug,
        nodeId: dagNode.id,
        err: (err as Error).message,
      });
    }
  }

  const session = ctx.sessions.get(slug);
  const worktreePath = session?.worktreePath;
  if (!worktreePath) return result;

  try {
    await rebaseOnto({ worktreePath, branch: result.newBase });
  } catch (err) {
    if (ctx.sessions.get(slug)) {
      ctx.sessions.appendAttention(slug, {
        kind: "rebase_conflict",
        message: `Re-base after live-base re-resolution failed: ${(err as Error).message}`,
        raisedAt: new Date().toISOString(),
      });
    }
    throw err;
  }

  return result;
}
