import { simpleGit } from "simple-git";
import type { WorkspaceDiff, DiffStat } from "@minions/shared";
import { nowIso } from "../util/time.js";
import { EngineError } from "../errors.js";

const MAX_PATCH_BYTES = 256 * 1024;

interface SessionWorktreeInfo {
  worktreePath: string;
  baseBranch?: string;
}

export async function computeDiff(slug: string, info: SessionWorktreeInfo): Promise<WorkspaceDiff> {
  const { worktreePath, baseBranch } = info;

  if (!worktreePath) {
    throw new EngineError("bad_request", `Session ${slug} has no worktree`);
  }

  const git = simpleGit(worktreePath);

  let baseSha: string | undefined;
  let headSha: string | undefined;

  try {
    headSha = (await git.revparse(["HEAD"])).trim();
  } catch {
    headSha = undefined;
  }

  const base = baseBranch ?? "main";
  baseSha = await resolveBase(git, base);

  let patch = "";
  try {
    if (baseSha) {
      patch = await git.diff([baseSha]);
    } else {
      patch = await git.diff(["HEAD"]);
    }
  } catch {
    patch = "";
  }

  const stats: DiffStat[] = [];

  try {
    const statOutput = baseSha
      ? await git.diff(["--stat", "--stat-width=500", baseSha])
      : await git.diff(["--stat", "--stat-width=500", "HEAD"]);
    stats.push(...parseStatOutput(statOutput));
  } catch {
  }

  try {
    const statusResult = await git.status();
    for (const f of statusResult.not_added) {
      if (!stats.find((s) => s.path === f)) {
        stats.push({ path: f, additions: 0, deletions: 0, status: "untracked" });
      }
    }
  } catch {
  }

  const byteSize = Buffer.byteLength(patch, "utf8");
  const truncated = byteSize > MAX_PATCH_BYTES;
  const finalPatch = truncated ? Buffer.from(patch, "utf8").slice(0, MAX_PATCH_BYTES).toString("utf8") : patch;

  return {
    sessionSlug: slug,
    baseSha: typeof baseSha === "string" ? baseSha : undefined,
    headSha,
    patch: finalPatch,
    stats,
    truncated,
    byteSize,
    generatedAt: nowIso(),
  };
}

async function resolveBase(git: ReturnType<typeof simpleGit>, branch: string): Promise<string | undefined> {
  try {
    return (await git.revparse([`origin/${branch}`])).trim();
  } catch {
    try {
      return (await git.revparse([branch])).trim();
    } catch {
      return undefined;
    }
  }
}

function parseStatOutput(statOutput: string): DiffStat[] {
  const stats: DiffStat[] = [];
  const lines = statOutput.split("\n");
  for (const line of lines) {
    const match = /^\s*(.+?)\s*\|\s*(\d+)\s*([\+\-]*)/.exec(line);
    if (!match) continue;
    const rawPath = match[1]?.trim() ?? "";
    const insertions = (match[3]?.match(/\+/g) ?? []).length;
    const deletions = (match[3]?.match(/-/g) ?? []).length;

    const renameMatch = /^(.+) => (.+)$/.exec(rawPath);
    if (renameMatch) {
      stats.push({
        path: renameMatch[2]?.trim() ?? rawPath,
        oldPath: renameMatch[1]?.trim(),
        additions: insertions,
        deletions,
        status: "renamed",
      });
    } else {
      stats.push({
        path: rawPath,
        additions: insertions,
        deletions,
        status: "modified",
      });
    }
  }
  return stats;
}
