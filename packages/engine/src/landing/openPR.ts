import { spawn } from "node:child_process";
import type { PRReviewDecision, PRSummary } from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import { EngineError } from "../errors.js";
import { parseGithubRemote } from "../github/parseRemote.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";

export interface EnsurePullRequestArgs {
  ctx: EngineContext;
  slug: string;
  log: Logger;
}

interface GhPrViewJson {
  number: number;
  url: string;
  state: string;
  title: string;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
  reviewDecision?: string | null;
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

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`gh ${args.join(" ")} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

function mapState(raw: string): PRSummary["state"] {
  const upper = raw.toUpperCase();
  if (upper === "MERGED") return "merged";
  if (upper === "CLOSED") return "closed";
  return "open";
}

export async function ensurePullRequest(
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
  const repoArg = `${parsed.owner}/${parsed.repo}`;
  const body = `Created by minions session ${slug}.`;

  let createOutput: string;
  try {
    createOutput = await runGh([
      "pr",
      "create",
      "--title",
      session.title,
      "--body",
      body,
      "--base",
      baseBranch,
      "--head",
      session.branch,
      "--repo",
      repoArg,
    ]);
  } catch (err) {
    throw new EngineError("upstream", `gh pr create failed: ${(err as Error).message}`);
  }

  const urlMatch = createOutput.match(/https?:\/\/\S+\/pull\/(\d+)/);
  if (!urlMatch) {
    throw new EngineError("upstream", `could not parse PR url from gh output: ${createOutput}`);
  }
  const fallbackUrl = urlMatch[0];
  const fallbackNumber = Number(urlMatch[1]);

  let summary: PRSummary;
  try {
    const viewRaw = await runGh([
      "pr",
      "view",
      String(fallbackNumber),
      "--repo",
      repoArg,
      "--json",
      "number,url,state,title,baseRefName,headRefName,isDraft,reviewDecision",
    ]);
    const view = JSON.parse(viewRaw) as GhPrViewJson;
    summary = {
      number: view.number,
      url: view.url,
      state: mapState(view.state),
      draft: view.isDraft,
      base: view.baseRefName,
      head: view.headRefName,
      title: view.title,
      reviewDecision: normalizeReviewDecision(view.reviewDecision),
    };
  } catch (err) {
    log.warn("gh pr view failed, using fallback summary", {
      slug,
      err: (err as Error).message,
    });
    summary = {
      number: fallbackNumber,
      url: fallbackUrl,
      state: "open",
      draft: false,
      base: baseBranch,
      head: session.branch,
      title: session.title,
    };
  }

  const sessionRepo = new SessionRepo(ctx.db);
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
}
