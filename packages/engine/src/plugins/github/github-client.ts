import type { TokenBucket } from "./rate-limiter.js";
import { createLogger, type Logger } from "../../observability/logger.js";

const GITHUB_API = "https://api.github.com";

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "minions-workflow-core/0.1",
  };
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly retryAfter?: number;

  constructor(status: number, url: string, body: string, retryAfter?: number) {
    super(`GitHub API error ${status} for ${url}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.url = url;
    this.body = body;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export interface GhPRRef {
  number: number;
  url: string;
  headRef: string;
  baseRef: string;
  state: string;
}

export interface GhPRDetail {
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  state: string;
  merged: boolean;
  mergeCommitSha?: string;
}

export interface GhMergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface CreatePROpts {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface MergePROpts {
  expectedHeadSha?: string;
  method?: "merge" | "squash" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}

export interface GhCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | "pending";
  htmlUrl?: string;
  startedAt?: string;
  completedAt?: string;
  output?: { title?: string; summary?: string; text?: string };
}

const KNOWN_CONCLUSIONS = new Set([
  "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "pending",
]);

export interface GitHubClientDeps {
  token: string;
  bucket: TokenBucket;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

export class GitHubClient {
  private readonly token: string;
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;

  constructor(deps: GitHubClientDeps) {
    this.token = deps.token;
    this.bucket = deps.bucket;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.log = deps.log ?? createLogger("info", []);
  }

  private async request(url: string, init?: RequestInit): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...baseHeaders(this.token),
        ...(init?.headers as Record<string, string> | undefined ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader !== null ? parseInt(retryAfterHeader, 10) : undefined;
      throw new GitHubApiError(res.status, url, body, isNaN(retryAfter ?? NaN) ? undefined : retryAfter);
    }

    const text = await res.text();
    if (text === "") return undefined;
    return JSON.parse(text) as unknown;
  }

  async findPRByHead(
    owner: string,
    repo: string,
    head: string,
    base: string,
  ): Promise<GhPRRef | null> {
    await this.bucket.acquire();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open&per_page=1`;
    let data: unknown;
    try {
      data = await this.request(url);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
    const prs = data as Array<{ number: number; html_url: string; head: { ref: string }; base: { ref: string }; state: string }>;
    if (!Array.isArray(prs) || prs.length === 0) return null;
    const pr = prs[0]!;
    return { number: pr.number, url: pr.html_url, headRef: pr.head.ref, baseRef: pr.base.ref, state: pr.state };
  }

  async createPR(
    owner: string,
    repo: string,
    opts: CreatePROpts,
  ): Promise<GhPRRef> {
    await this.bucket.acquire();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls`;
    const pr = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
        draft: opts.draft ?? false,
      }),
    }) as { number: number; html_url: string; head: { ref: string }; base: { ref: string }; state: string };
    return { number: pr.number, url: pr.html_url, headRef: pr.head.ref, baseRef: pr.base.ref, state: pr.state };
  }

  async getPR(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GhPRDetail> {
    await this.bucket.acquire();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`;
    const pr = await this.request(url) as {
      number: number;
      html_url: string;
      head: { sha: string; ref: string };
      base: { ref: string };
      mergeable: boolean | null;
      mergeable_state: string | null;
      state: string;
      merged: boolean;
      merge_commit_sha: string | null;
    };
    return {
      number: pr.number,
      url: pr.html_url,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      state: pr.state,
      merged: pr.merged,
      ...(pr.merge_commit_sha !== null ? { mergeCommitSha: pr.merge_commit_sha } : {}),
    };
  }

  async listCheckRuns(owner: string, repo: string, headSha: string): Promise<GhCheckRun[]> {
    type RawRun = {
      name: string;
      status: string;
      conclusion: string | null;
      html_url?: string;
      started_at?: string;
      completed_at?: string;
      output?: { title?: string; summary?: string; text?: string };
    };

    const mapCheckRuns = (rawRuns: RawRun[]): GhCheckRun[] =>
      rawRuns.map((r) => {
        const run: GhCheckRun = {
          name: r.name,
          status: r.status as GhCheckRun["status"],
        };
        if (r.conclusion !== null && KNOWN_CONCLUSIONS.has(r.conclusion)) {
          run.conclusion = r.conclusion as Exclude<GhCheckRun["conclusion"], undefined>;
        }
        if (r.html_url !== undefined) run.htmlUrl = r.html_url;
        if (r.started_at !== undefined) run.startedAt = r.started_at;
        if (r.completed_at !== undefined) run.completedAt = r.completed_at;
        if (r.output !== undefined) run.output = r.output;
        return run;
      });

    const all: GhCheckRun[] = [];
    let nextUrl: string | null = `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`;
    let pages = 0;
    const maxPages = 10; // safety cap against runaway pagination

    while (nextUrl !== null && pages < maxPages) {
      await this.bucket.acquire();
      const pageUrl = `${GITHUB_API}${nextUrl}`;
      const res: Response = await this.fetchImpl(pageUrl, {
        headers: baseHeaders(this.token),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfter = retryAfterHeader !== null ? parseInt(retryAfterHeader, 10) : undefined;
        throw new GitHubApiError(res.status, pageUrl, body, isNaN(retryAfter ?? NaN) ? undefined : retryAfter);
      }

      const text = await res.text();
      const data = JSON.parse(text) as { total_count: number; check_runs: RawRun[] };
      all.push(...mapCheckRuns(data.check_runs));

      const linkHeader: string | null = res.headers.get("Link");
      nextUrl = linkHeader !== null ? parseNextLink(linkHeader) : null;
      pages++;
    }

    if (nextUrl !== null && pages === maxPages) {
      this.log.warn("listCheckRuns: hit page cap", { owner, repo, headSha, maxPages });
    }

    return all;
  }

  async mergePR(
    owner: string,
    repo: string,
    number: number,
    opts: MergePROpts = {},
  ): Promise<GhMergeResult> {
    await this.bucket.acquire();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/merge`;
    const body: Record<string, unknown> = {
      merge_method: opts.method ?? "merge",
    };
    if (opts.expectedHeadSha !== undefined) body["sha"] = opts.expectedHeadSha;
    if (opts.commitTitle !== undefined) body["commit_title"] = opts.commitTitle;
    if (opts.commitMessage !== undefined) body["commit_message"] = opts.commitMessage;

    const result = await this.request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as { merged: boolean; sha: string; message: string };
    return result;
  }
}

function parseNextLink(linkHeader: string): string | null {
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      const fullUrl = match[1]!;
      // Strip the base URL prefix to return a path-relative URL
      if (fullUrl.startsWith(GITHUB_API)) {
        return fullUrl.slice(GITHUB_API.length);
      }
      return fullUrl;
    }
  }
  return null;
}
