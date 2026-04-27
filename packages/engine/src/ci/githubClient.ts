import type { PullRequestPreview, CheckRun, CheckConclusion } from "@minions/shared";
import { EngineError } from "../errors.js";
import { appConfigured } from "../github/app.js";

const GITHUB_API = "https://api.github.com";

export interface AuthContext {
  github: { getToken: () => Promise<string> };
}

export async function authHeader(ctx: AuthContext): Promise<{ Authorization: string }> {
  if (appConfigured()) {
    const token = await ctx.github.getToken();
    return { Authorization: `Bearer ${token}` };
  }
  const pat = process.env["GITHUB_TOKEN"] ?? "";
  if (!pat) {
    throw new EngineError("unauthorized", "no GitHub credentials configured");
  }
  return { Authorization: `Bearer ${pat}` };
}

function baseHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "minions-engine/0.1",
  };
}

async function ghFetch(ctx: AuthContext, url: string, init?: RequestInit): Promise<unknown> {
  const auth = await authHeader(ctx);
  const res = await fetch(url, {
    ...init,
    headers: {
      ...baseHeaders(),
      ...auth,
      ...(init?.headers as Record<string, string> | undefined ?? {}),
    },
  });
  if (!res.ok) {
    throw new EngineError(
      "upstream",
      `GitHub API error ${res.status} for ${url}: ${await res.text().catch(() => "")}`,
    );
  }
  return res.json();
}

export function parseOwnerRepo(remote: string): { owner: string; repo: string } {
  const m = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (!m?.[1] || !m?.[2]) {
    throw new EngineError("bad_request", `Cannot parse owner/repo from remote: ${remote}`);
  }
  return { owner: m[1], repo: m[2] };
}

interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface GhCheckRunsResponse {
  check_runs: GhCheckRun[];
}

interface GhPR {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  base: { ref: string };
  head: { ref: string; sha: string };
  mergeable: boolean | null;
  mergeable_state: string | null;
  review_decision?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  updated_at: string;
}

function mapConclusion(c: string | null): CheckConclusion | undefined {
  if (!c) return undefined;
  const valid: CheckConclusion[] = [
    "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "pending",
  ];
  return (valid as string[]).includes(c) ? (c as CheckConclusion) : undefined;
}

export async function listChecks(
  ctx: AuthContext,
  owner: string,
  repo: string,
  sha: string,
): Promise<CheckRun[]> {
  const data = await ghFetch(
    ctx,
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
  ) as GhCheckRunsResponse;
  return data.check_runs.map((r) => ({
    name: r.name,
    status: r.status as CheckRun["status"],
    conclusion: mapConclusion(r.conclusion),
    url: r.html_url ?? undefined,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
  }));
}

export async function getPR(
  ctx: AuthContext,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestPreview> {
  const pr = await ghFetch(ctx, `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`) as GhPR;

  const sha = pr.head.sha;
  let checks: CheckRun[] = [];
  try {
    checks = await listChecks(ctx, owner, repo, sha);
  } catch {
    checks = [];
  }

  const prState: PullRequestPreview["state"] = pr.state === "open" ? "open" : "closed";

  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? "",
    state: prState,
    draft: pr.draft,
    base: pr.base.ref,
    head: pr.head.ref,
    mergeable: pr.mergeable ?? undefined,
    mergeableState: pr.mergeable_state ?? undefined,
    reviewDecision: (pr.review_decision as PullRequestPreview["reviewDecision"]) ?? null,
    checks,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    updatedAt: pr.updated_at,
  };
}

export async function postIssueComment(
  ctx: AuthContext,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await ghFetch(ctx, `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
}
