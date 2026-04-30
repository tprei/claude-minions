import path from "node:path";
import fs from "node:fs/promises";
import pLimit from "p-limit";
import type {
  CleanupCandidate,
  CleanupCandidatesResponse,
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

export interface SelectCandidatesOptions {
  olderThanDays: number;
  statuses: CleanupableStatus[];
  limit: number;
  cursor?: string | null;
}

export interface CleanupSubsystem {
  selectCandidates(opts: SelectCandidatesOptions): Promise<CleanupCandidatesResponse>;
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
const PREVIEW_DU_CONCURRENCY = 4;
const PREVIEW_DU_TIMEOUT_MS = 5_000;
const EXECUTE_CONCURRENCY = 8;

async function runWithConcurrency<T, R>(
  items: T[],
  n: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array(Math.min(n, items.length))
    .fill(null)
    .map(async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]!);
      }
    });
  await Promise.all(workers);
  return results;
}

interface PageCursorShape {
  updatedAt: string;
  slug: string;
}

function encodeCursor(c: PageCursorShape): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): PageCursorShape | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { updatedAt?: unknown; slug?: unknown };
    if (typeof parsed.updatedAt !== "string" || typeof parsed.slug !== "string") return null;
    return { updatedAt: parsed.updatedAt, slug: parsed.slug };
  } catch {
    return null;
  }
}

async function diskUsageWithTimeout(absPath: string, timeoutMs: number): Promise<number> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(0), timeoutMs);
  });
  try {
    const result = await Promise.race([
      diskUsage(absPath).then((r) => r.bytes),
      timeout,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function makeCleanupSubsystem(deps: CleanupSubsystemDeps): CleanupSubsystem {
  const { sessions, audit, workspaceDir, reposDir, worktreeRoot, log } = deps;

  async function selectCandidates(
    opts: SelectCandidatesOptions,
  ): Promise<CleanupCandidatesResponse> {
    const cutoff =
      opts.olderThanDays > 0 ? Date.now() - opts.olderThanDays * DAY_MS : Number.POSITIVE_INFINITY;
    const noAgeFilter = opts.olderThanDays === 0;

    const items: CleanupCandidate[] = [];
    let cursor: PageCursorShape | undefined = opts.cursor
      ? decodeCursor(opts.cursor) ?? undefined
      : undefined;

    let nextCursor: PageCursorShape | undefined;
    let exhausted = false;

    while (items.length < opts.limit && !exhausted) {
      const page = sessions.listPaged({
        status: opts.statuses,
        limit: opts.limit,
        cursor,
      });

      for (const s of page.items) {
        if (items.length >= opts.limit) break;
        if (!noAgeFilter) {
          if (!s.completedAt) continue;
          const ts = Date.parse(s.completedAt);
          if (Number.isNaN(ts)) continue;
          if (ts > cutoff) continue;
        }
        items.push(toCandidate(s));
        nextCursor = { updatedAt: s.updatedAt, slug: s.slug };
      }

      if (!page.nextCursor) {
        exhausted = true;
        if (items.length < opts.limit) {
          nextCursor = undefined;
        }
        break;
      }
      cursor = page.nextCursor;
    }

    if (exhausted && items.length < opts.limit) {
      nextCursor = undefined;
    }

    return {
      items,
      nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
    };
  }

  async function preview(req: CleanupPreviewRequest): Promise<CleanupPreviewResponse> {
    const ineligible: { slug: string; reason: string }[] = [];
    const sizeTasks: Array<() => Promise<number>> = [];

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
        const wt = s.worktreePath;
        sizeTasks.push(() => diskUsageWithTimeout(wt, PREVIEW_DU_TIMEOUT_MS));
      }
    }

    const limiter = pLimit(PREVIEW_DU_CONCURRENCY);
    const sizes = await Promise.all(sizeTasks.map((task) => limiter(task)));
    const totalBytes = sizes.reduce((acc, n) => acc + n, 0);

    return {
      count: req.slugs.length - ineligible.length,
      totalBytes,
      ineligible,
    };
  }

  async function execute(req: CleanupExecuteRequest): Promise<CleanupExecuteResponse> {
    interface SlugOutcome {
      deleted: boolean;
      bytesReclaimed: number;
      errors: CleanupExecuteError[];
    }

    async function processSlug(slug: string): Promise<SlugOutcome> {
      const slugErrors: CleanupExecuteError[] = [];
      const s = sessions.get(slug);
      if (!s) {
        return {
          deleted: false,
          bytesReclaimed: 0,
          errors: [{ slug, code: "not_found", message: `Session ${slug} not found` }],
        };
      }
      if (INELIGIBLE_RUNTIME_STATUSES.has(s.status)) {
        return {
          deleted: false,
          bytesReclaimed: 0,
          errors: [
            { slug, code: "ineligible_status", message: `Session ${slug} status=${s.status}` },
          ],
        };
      }

      let measuredBytes = 0;
      if (req.removeWorktree && s.worktreePath) {
        measuredBytes = await diskUsageWithTimeout(s.worktreePath, PREVIEW_DU_TIMEOUT_MS);
      }

      let worktreeRemoved = false;
      if (req.removeWorktree && s.repoId && s.worktreePath) {
        try {
          await removeWorktree(reposDir, worktreeRoot, s.repoId, slug, log);
          worktreeRemoved = true;
        } catch (err) {
          slugErrors.push({
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
        slugErrors.push({ slug, code: "internal", message: String(err) });
        return { deleted: false, bytesReclaimed: 0, errors: slugErrors };
      }

      audit.record(
        "operator",
        "session.cleanup",
        { kind: "session", id: slug },
        { bytesReclaimed: measuredBytes, removeWorktree: req.removeWorktree },
      );

      return {
        deleted: true,
        bytesReclaimed: worktreeRemoved ? measuredBytes : 0,
        errors: slugErrors,
      };
    }

    const outcomes = await runWithConcurrency(req.slugs, EXECUTE_CONCURRENCY, processSlug);

    const errors: CleanupExecuteError[] = [];
    let bytesReclaimed = 0;
    let deleted = 0;
    for (const o of outcomes) {
      if (o.deleted) deleted++;
      bytesReclaimed += o.bytesReclaimed;
      if (o.errors.length > 0) errors.push(...o.errors);
    }

    return { deleted, bytesReclaimed, errors };
  }

  return { selectCandidates, preview, execute };
}

function toCandidate(s: Session): CleanupCandidate {
  return {
    slug: s.slug,
    title: s.title,
    status: s.status,
    completedAt: s.completedAt ?? null,
    worktreePath: s.worktreePath ?? null,
    branch: s.branch ?? null,
  };
}
