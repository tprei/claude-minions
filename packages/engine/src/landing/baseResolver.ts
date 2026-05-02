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
  try {
    await git.fetch("origin", branch);
  } catch (fetchErr) {
    // Best-effort fetch: if the remote-tracking update fails (network blip,
    // ref already up to date, refspec not present, etc.), the local ref may
    // still be fresh enough — let the rebase attempt below decide.
  }

  // Try `origin/<branch>` first (standard remote-tracking) and fall back to
  // the local branch ref `<branch>`. The bare-clone-shared-with-worktrees
  // setup means the local ref gets pushed-into directly when descendants
  // worktree-add against it, so it's often more current than the remote-
  // tracking copy. Either is acceptable as a rebase target.
  let lastErr: Error | null = null;
  for (const target of [`origin/${branch}`, branch]) {
    try {
      await git.rebase([target]);
      return;
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("conflict") || message.includes("CONFLICT")) {
        await git.rebase(["--abort"]).catch(() => {});
        throw new Error(`rebase conflict: ${message}`);
      }
      lastErr = err as Error;
      // Try the next target — likely the first failed because the ref
      // doesn't exist locally yet.
    }
  }
  throw lastErr ?? new Error(`rebase failed for branch ${branch}`);
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

/**
 * Walks the dependency chain from `slug` outward, returning the chain of
 * candidate base branches (most-specific first, ending with the dag's base
 * and "main" as a final safety net). Used by `applyLiveBase` to try one
 * candidate at a time if the first one's rebase fails for a non-conflict
 * reason (e.g. local origin/<branch> ref missing because the dep finished
 * pushing milliseconds ago).
 */
function collectBaseCandidates(
  slug: string,
  deps: { ctx: EngineContext; dagRepo: DagRepo },
): string[] {
  const { ctx, dagRepo } = deps;
  const session = ctx.sessions.get(slug);
  if (!session) return ["main"];
  const intended = session.baseBranch ?? "main";
  const out: string[] = [intended];
  const seen = new Set<string>(out);

  const dagNode = dagRepo.getNodeBySession(slug);
  const dag = dagRepo.byNodeSession(slug);
  if (dagNode && dag) {
    const queue = [...dagNode.dependsOn];
    const visited = new Set<string>();
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
      if (depBranch && !seen.has(depBranch)) {
        out.push(depBranch);
        seen.add(depBranch);
      }
      queue.push(...depNode.dependsOn);
    }
    const dagBase = dag.baseBranch ?? "main";
    if (!seen.has(dagBase)) {
      out.push(dagBase);
      seen.add(dagBase);
    }
  }
  if (!seen.has("main")) out.push("main");
  return out;
}

export async function applyLiveBase(
  slug: string,
  deps: ApplyLiveBaseDeps,
): Promise<LiveBaseResult> {
  const { ctx, dagRepo, log, sessionRepo, branchExists, rebaseOnto } = deps;

  const result = await resolveLiveBase(slug, { ctx, dagRepo, branchExists, log });
  if (!result.changed) return result;

  const session = ctx.sessions.get(slug);
  const worktreePath = session?.worktreePath;
  if (!worktreePath) return result;

  // Walk candidates: the resolver's first pick, then the rest of the chain
  // up through dag baseBranch and "main". If a candidate's rebase fails for
  // a non-conflict reason (e.g. local origin/<branch> ref isn't fetched yet
  // because the dep finished pushing milliseconds ago), try the next one.
  // Only `conflict` errors short-circuit — those are real semantic problems.
  const intended = result.oldBase;
  const initialCandidates = collectBaseCandidates(slug, { ctx, dagRepo });
  const candidates: string[] = [result.newBase];
  for (const c of initialCandidates) {
    if (!candidates.includes(c)) candidates.push(c);
  }
  if (!candidates.includes("main")) candidates.push("main");

  let lastErr: Error | null = null;
  const dagNode = dagRepo.getNodeBySession(slug);

  for (const candidate of candidates) {
    if (candidate === intended) continue; // already covered by !changed fast-path
    if (
      candidate !== result.newBase &&
      !(await branchExists({ worktreePath, branch: candidate })) &&
      candidate !== "main"
    ) {
      log.debug("base candidate missing on origin, skipping", { slug, candidate });
      continue;
    }
    try {
      await rebaseOnto({ worktreePath, branch: candidate });

      const finalReason: LiveBaseReason =
        candidate === result.newBase
          ? result.reason
          : candidate === "main"
            ? "default-fallback"
            : "ancestor-fallback";

      ctx.audit.record(
        "system",
        "landing.base.resolved",
        { kind: "session", id: slug },
        { oldBase: intended, newBase: candidate, reason: finalReason },
      );
      if (sessionRepo) sessionRepo.update(slug, { baseBranch: candidate });
      if (dagNode) {
        try {
          dagRepo.updateNode(dagNode.id, { baseBranch: candidate });
        } catch (err) {
          log.warn("failed to update dag node base after re-resolution", {
            slug,
            nodeId: dagNode.id,
            err: (err as Error).message,
          });
        }
      }
      return {
        oldBase: intended,
        newBase: candidate,
        changed: candidate !== intended,
        reason: finalReason,
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("conflict") || msg.includes("CONFLICT")) {
        if (ctx.sessions.get(slug)) {
          ctx.sessions.appendAttention(slug, {
            kind: "rebase_conflict",
            message: `Re-base after live-base re-resolution failed: ${msg}`,
            raisedAt: new Date().toISOString(),
          });
        }
        throw err;
      }
      lastErr = err as Error;
      log.warn("rebase onto ancestor candidate failed; trying next", {
        slug,
        candidate,
        err: msg,
      });
    }
  }

  // Exhausted every candidate including main.
  if (ctx.sessions.get(slug)) {
    ctx.sessions.appendAttention(slug, {
      kind: "rebase_conflict",
      message: `Live-base resolution exhausted all candidates: ${lastErr?.message ?? "unknown"}`,
      raisedAt: new Date().toISOString(),
    });
  }
  throw lastErr ?? new Error("live-base resolution exhausted all candidates");
}
