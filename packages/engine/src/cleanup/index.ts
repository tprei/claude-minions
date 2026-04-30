import path from "node:path";
import fs from "node:fs/promises";
import type {
  CleanupCandidate,
  CleanupableStatus,
  CleanupExecuteError,
  CleanupExecuteRequest,
  CleanupExecuteResponse,
  CleanupPreviewRequest,
  CleanupPreviewResponse,
  Session,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { EventBus } from "../bus/eventBus.js";
import type { Logger } from "../logger.js";
import { removeWorktree } from "../workspace/worktree.js";
import { diskUsage } from "../util/diskUsage.js";

export interface CleanupSubsystem {
  selectCandidates(opts: { olderThanDays: number; statuses: CleanupableStatus[] }): Promise<CleanupCandidate[]>;
  preview(req: CleanupPreviewRequest): Promise<CleanupPreviewResponse>;
  execute(req: CleanupExecuteRequest): Promise<CleanupExecuteResponse>;
}

export interface CleanupSubsystemDeps {
  sessions: EngineContext["sessions"];
  audit: EngineContext["audit"];
  workspaceDir: string;
  reposDir: string;
  worktreeRoot: string;
  log: Logger;
  bus: EventBus;
}

const INELIGIBLE_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "waiting_input",
  "pending",
]);

const DAY_MS = 86_400_000;

export function makeCleanupSubsystem(deps: CleanupSubsystemDeps): CleanupSubsystem {
  const { sessions, audit, workspaceDir, reposDir, worktreeRoot, log } = deps;

  async function selectCandidates(opts: {
    olderThanDays: number;
    statuses: CleanupableStatus[];
  }): Promise<CleanupCandidate[]> {
    const result = sessions.listPaged({ status: opts.statuses, limit: 250 });
    const cutoff = Date.now() - opts.olderThanDays * DAY_MS;

    const eligible: Session[] = [];
    for (const s of result.items) {
      if (!s.completedAt) continue;
      const ts = Date.parse(s.completedAt);
      if (Number.isNaN(ts)) continue;
      if (ts > cutoff) continue;
      eligible.push(s);
    }

    const usages = await Promise.all(
      eligible.map((s) =>
        s.worktreePath ? diskUsage(s.worktreePath) : Promise.resolve({ bytes: 0, missing: true }),
      ),
    );

    return eligible.map((s, i) => ({
      slug: s.slug,
      title: s.title,
      status: s.status,
      completedAt: s.completedAt ?? null,
      worktreePath: s.worktreePath ?? null,
      worktreeBytes: usages[i]!.bytes,
      branch: s.branch ?? null,
    }));
  }

  async function preview(req: CleanupPreviewRequest): Promise<CleanupPreviewResponse> {
    const ineligible: { slug: string; reason: string }[] = [];
    let totalBytes = 0;

    for (const slug of req.slugs) {
      const s = sessions.get(slug);
      if (!s) {
        ineligible.push({ slug, reason: "not_found" });
        continue;
      }
      if (INELIGIBLE_RUNTIME_STATUSES.has(s.status)) {
        ineligible.push({ slug, reason: `ineligible_status:${s.status}` });
        continue;
      }
      if (req.removeWorktree && s.worktreePath) {
        const du = await diskUsage(s.worktreePath);
        totalBytes += du.bytes;
      }
    }

    return {
      count: req.slugs.length - ineligible.length,
      totalBytes,
      ineligible,
    };
  }

  async function execute(req: CleanupExecuteRequest): Promise<CleanupExecuteResponse> {
    const errors: CleanupExecuteError[] = [];
    let bytesReclaimed = 0;
    let deleted = 0;

    for (const slug of req.slugs) {
      const s = sessions.get(slug);
      if (!s) {
        errors.push({ slug, code: "not_found", message: `Session ${slug} not found` });
        continue;
      }
      if (INELIGIBLE_RUNTIME_STATUSES.has(s.status)) {
        errors.push({
          slug,
          code: "ineligible_status",
          message: `Session ${slug} status=${s.status}`,
        });
        continue;
      }

      let measuredBytes = 0;
      if (req.removeWorktree && s.worktreePath) {
        const du = await diskUsage(s.worktreePath);
        measuredBytes = du.bytes;
      }

      let worktreeRemoved = false;
      if (req.removeWorktree && s.repoId && s.worktreePath) {
        try {
          await removeWorktree(reposDir, worktreeRoot, s.repoId, slug, log);
          worktreeRemoved = true;
        } catch (err) {
          errors.push({
            slug,
            code: "worktree_remove_failed",
            message: String(err),
          });
        }
      }

      const sideTargets = [
        path.join(workspaceDir, "uploads", slug),
        path.join(workspaceDir, "reply-queue", `${slug}.jsonl`),
        path.join(workspaceDir, "mcp-configs", `${slug}.json`),
      ];
      for (const target of sideTargets) {
        try {
          await fs.rm(target, { recursive: true, force: true });
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== "ENOENT") {
            log.warn("cleanup side-effect rm failed", { slug, target, err: String(err) });
          }
        }
      }

      try {
        await sessions.delete(slug);
      } catch (err) {
        errors.push({ slug, code: "internal", message: String(err) });
        continue;
      }

      audit.record(
        "operator",
        "session.cleanup",
        { kind: "session", id: slug },
        { bytesReclaimed: measuredBytes, removeWorktree: req.removeWorktree },
      );

      deleted++;
      if (worktreeRemoved) bytesReclaimed += measuredBytes;
    }

    return { deleted, bytesReclaimed, errors };
  }

  return { selectCandidates, preview, execute };
}
