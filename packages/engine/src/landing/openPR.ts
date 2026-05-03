import type { PRReviewDecision, PRSummary } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import { EngineError } from "../errors.js";
import { parseGithubRemote } from "../github/parseRemote.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";
import { buildPrBody } from "./buildPrBody.js";
import type { SessionStateUpdater } from "./sessionStateUpdater.js";

export interface EnsurePullRequestDeps {
  sessionRepo?: SessionStateUpdater;
}

export interface EnsurePullRequestArgs {
  ctx: EngineContext;
  slug: string;
  log: Logger;
}

export function normalizeReviewDecision(raw: unknown): PRReviewDecision | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return null;
  if (
    normalized === "approved" ||
    normalized === "changes_requested" ||
    normalized === "commented" ||
    normalized === "review_required"
  ) {
    return normalized;
  }
  return null;
}

export function createEnsurePullRequest(deps: EnsurePullRequestDeps = {}) {
  return async function ensurePullRequest(
    args: EnsurePullRequestArgs,
  ): Promise<PRSummary | null> {
    const { ctx, slug, log } = args;

    const session = ctx.sessions.get(slug);
    if (!session) {
      throw new EngineError("not_found", `session not found: ${slug}`);
    }
    if (session.pr) {
      return session.pr;
    }

    if (!session.repoId) {
      log.info("ensurePullRequest: session has no repoId, skipping", { slug });
      return null;
    }

    const repo = ctx.repos().find((r) => r.id === session.repoId);
    if (!repo?.remote) {
      log.info("ensurePullRequest: repo has no remote, skipping", { slug, repoId: session.repoId });
      return null;
    }

    const parsed = parseGithubRemote(repo.remote);
    if (!parsed) {
      log.info("ensurePullRequest: remote is not a GitHub URL, skipping", {
        slug,
        remote: repo.remote,
      });
      return null;
    }

    if (!session.branch) {
      throw new EngineError("bad_request", `session ${slug} has no branch`);
    }

    const baseBranch = session.baseBranch ?? "main";
    const sessionRepo: SessionStateUpdater = deps.sessionRepo ?? new SessionRepo(ctx.db);

    const existing = await ctx.github.findPRByHead(session.repoId, session.branch, baseBranch);

    if (existing) {
      if (existing.state === "open") {
        const summary: PRSummary = {
          number: existing.number,
          url: existing.url,
          state: "open",
          draft: false,
          base: existing.baseRef,
          head: existing.headRef,
          title: session.title,
        };
        sessionRepo.setPr(slug, summary);
        const refreshed = ctx.sessions.get(slug);
        if (refreshed) {
          ctx.bus.emit({ kind: "session_updated", session: refreshed });
        }
        ctx.audit.record(
          "system",
          "landing.pr.ensure.reused",
          { kind: "session", id: slug },
          { prNumber: summary.number, branch: session.branch },
        );
        log.info("PR reused for session", {
          slug,
          prNumber: summary.number,
          prUrl: summary.url,
        });
        return summary;
      }
      log.warn("existing PR is not open; creating a fresh PR for the same head branch", {
        slug,
        prNumber: existing.number,
        state: existing.state,
        branch: session.branch,
      });
    }

    const fallbackBody = `Created by minions session ${slug}.`;
    let body = fallbackBody;
    try {
      const diff = await ctx.sessions.diff(slug);
      const transcript = ctx.sessions.transcript(slug);
      let parentPr: { number: number; url: string; parentTitle: string } | null = null;
      if (session.parentSlug) {
        const parent = ctx.sessions.get(session.parentSlug);
        if (parent?.pr) {
          parentPr = {
            number: parent.pr.number,
            url: parent.pr.url,
            parentTitle: parent.title,
          };
        }
      }
      body = buildPrBody({
        session,
        diff,
        transcript,
        parentPr,
        webBaseUrl: "",
      });
    } catch (err) {
      log.warn("ensurePullRequest: failed to build rich PR body, falling back", {
        slug,
        error: err instanceof Error ? err.message : String(err),
      });
      body = fallbackBody;
    }

    const created = await ctx.github.createPR(session.repoId, {
      title: session.title,
      body,
      head: session.branch,
      base: baseBranch,
      draft: false,
    });

    const summary: PRSummary = {
      number: created.number,
      url: created.url,
      state: "open",
      draft: false,
      base: baseBranch,
      head: session.branch,
      title: session.title,
    };

    sessionRepo.setPr(slug, summary);

    const refreshed = ctx.sessions.get(slug);
    if (refreshed) {
      ctx.bus.emit({ kind: "session_updated", session: refreshed });
    }

    log.info("PR ensured for session", {
      slug,
      prNumber: summary.number,
      prUrl: summary.url,
    });

    return summary;
  };
}

export const ensurePullRequest = createEnsurePullRequest();
