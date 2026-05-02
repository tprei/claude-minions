import type { PullRequestPreview, CheckRun, CheckConclusion } from "@minions/shared";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";
import { EngineError } from "../errors.js";
import { RepoRepo } from "../store/repos/repoRepo.js";
import { parseGithubRemote } from "./parseRemote.js";
import { GithubAppAuth, type GithubAppConfig } from "./app.js";
import AdmZip from "adm-zip";

export interface GithubSubsystemDeps {
  db: Database.Database;
  log: Logger;
  githubToken: string | null;
  appConfig?: GithubAppConfig | null;
}

export interface FindPRResult {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  baseRef: string;
  headRef: string;
}

export interface GithubSubsystem {
  enabled: () => boolean;
  fetchPR: (repoId: string, prNumber: number) => Promise<PullRequestPreview>;
  postPRComment: (repoId: string, prNumber: number, body: string) => Promise<void>;
  getToken: () => Promise<string>;
  getAppJwt: () => string | null;
  findPRByHead: (repoId: string, head: string, base: string) => Promise<FindPRResult | null>;
  createPR: (repoId: string, payload: { title: string; body: string; head: string; base: string; draft?: boolean }) => Promise<{ number: number; url: string }>;
  editPRBase: (repoId: string, prNumber: number, newBase: string) => Promise<void>;
  mergePR: (repoId: string, prNumber: number, opts: { strategy: "merge" | "squash" | "rebase" }) => Promise<{ sha: string; merged: boolean }>;
  getCheckRollup: (repoId: string, ref: string) => Promise<CheckRollupResult>;
  fetchFailedLogs: (repoId: string, runId: string) => Promise<{ logsByJob: Record<string, string> }>;
  fetchActionsRunIdForBranch: (repoId: string, branch: string) => Promise<string | null>;
}

export interface CheckRollupResult {
  state: "passed" | "pending" | "failed";
  checks: GhCheck[];
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  pr: {
    number: number;
    url: string;
    state: "open" | "closed" | "merged";
    draft: boolean;
    baseRef: string;
    headRef: string;
    headSha: string;
    title: string;
  } | null;
}

export interface GhCheck {
  name: string;
  bucket: "pass" | "fail" | "pending";
  state: string;
  workflow: string;
  link: string;
}

interface GithubPRResponse {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  base: { ref: string };
  head: { ref: string; sha: string };
  mergeable: boolean | null;
  mergeable_state: string;
  merged_at: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  updated_at: string;
}

interface GithubCheckRunsResponse {
  check_runs: {
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string | null;
    started_at: string | null;
    completed_at: string | null;
    app?: { name?: string };
  }[];
}

interface GithubStatusResponse {
  statuses: {
    context: string;
    state: string;
    target_url: string | null;
    description: string | null;
  }[];
}

interface GithubPRReviewResponse {
  state: string;
}

interface GithubPRListResponse {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  base: { ref: string };
  head: { ref: string; sha: string };
}

interface GithubActionsRunsResponse {
  runs: {
    id: number;
    status: string;
    conclusion: string | null;
    head_branch: string;
  }[];
}

const FAIL_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const PASS_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const FAIL_STATES = new Set(["failure", "error"]);

const TAIL_LINES = 200;
const MAX_LOG_BYTES = 50 * 1024;

function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

function clipTailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

const RATE_LIMIT_MAX_INLINE_WAIT_MS = 12_000;

async function githubFetch(url: string, token: string, opts?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(opts?.headers as Record<string, string> | undefined ?? {}),
  };
  let res = await fetch(url, { ...opts, headers });
  if (!isRateLimited(res)) return res;

  // Rate limited (primary install-token limit or secondary abuse limit).
  // Honor Retry-After / X-RateLimit-Reset when within a short bound; longer
  // waits escalate to `transient_github_error` so callers' retry policy
  // (re-enqueued automation job) handles the backoff instead of blocking
  // this fetch for tens of minutes.
  const waitMs = computeRateLimitWaitMs(res);
  if (waitMs <= RATE_LIMIT_MAX_INLINE_WAIT_MS) {
    await sleep(waitMs);
    res = await fetch(url, { ...opts, headers });
    if (!isRateLimited(res)) return res;
  }

  const body = await res.text().catch(() => "");
  throw new EngineError(
    "transient_github_error",
    `GitHub API rate limited (status ${res.status}); retry after ~${Math.ceil(waitMs / 1000)}s: ${body.slice(0, 200)}`,
    { url, status: res.status, retryAfterMs: waitMs },
  );
}

export function isRateLimited(res: Response): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining === "0") return true;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null) return true;
  // Best effort: a 403 without rate-limit headers might be a real permission
  // error. Treat 403 as rate-limited only when it carries the typical
  // signals; otherwise let the caller see the original 403 and surface it.
  return false;
}

export function computeRateLimitWaitMs(res: Response): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60 * 60 * 1000);
    }
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const epochSeconds = Number.parseInt(reset, 10);
    if (Number.isFinite(epochSeconds)) {
      const delta = epochSeconds * 1000 - Date.now();
      if (delta > 0) return Math.min(delta, 60 * 60 * 1000);
    }
  }
  // Secondary rate limits (no headers) typically clear within a minute.
  return 5_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGithubSubsystem(deps: GithubSubsystemDeps): GithubSubsystem {
  const repoRepo = new RepoRepo(deps.db);
  const appAuth = deps.appConfig ? new GithubAppAuth(deps.appConfig) : null;

  async function getToken(): Promise<string> {
    if (appAuth) {
      return appAuth.getInstallationToken();
    }
    if (deps.githubToken) {
      return deps.githubToken;
    }
    throw new EngineError("unauthorized", "no GitHub credentials configured");
  }

  async function resolveOwnerRepo(repoId: string): Promise<{ owner: string; repo: string }> {
    const repoBinding = repoRepo.get(repoId);
    if (!repoBinding) {
      throw new EngineError("not_found", `Repo ${repoId} not found`);
    }
    if (!repoBinding.remote) {
      throw new EngineError("bad_request", `Repo ${repoId} has no remote configured`);
    }
    const parsed = parseGithubRemote(repoBinding.remote);
    if (!parsed) {
      throw new EngineError("bad_request", `Cannot parse GitHub remote: ${repoBinding.remote}`);
    }
    return parsed;
  }

  return {
    enabled() {
      return appAuth !== null || (deps.githubToken !== null && deps.githubToken !== "");
    },

    getToken,

    getAppJwt() {
      return appAuth ? appAuth.mintJwt() : null;
    },

    async fetchPR(repoId, prNumber) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const prRes = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        token
      );
      if (!prRes.ok) {
        throw new EngineError("upstream", `GitHub API error: ${prRes.status} ${prRes.statusText}`);
      }
      const pr = (await prRes.json()) as GithubPRResponse;

      const [checksRes, reviewsRes] = await Promise.all([
        githubFetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
          token
        ),
        githubFetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
          token
        ),
      ]);

      let checks: CheckRun[] = [];
      if (checksRes.ok) {
        const checksData = (await checksRes.json()) as GithubCheckRunsResponse;
        checks = checksData.check_runs.map((cr) => ({
          name: cr.name,
          status: cr.status as CheckRun["status"],
          conclusion: (cr.conclusion ?? undefined) as CheckConclusion | undefined,
          url: cr.html_url ?? undefined,
          startedAt: cr.started_at ?? undefined,
          completedAt: cr.completed_at ?? undefined,
        }));
      }

      let reviewDecision: PullRequestPreview["reviewDecision"] = null;
      if (reviewsRes.ok) {
        const reviews = (await reviewsRes.json()) as GithubPRReviewResponse[];
        const states = reviews.map((r) => r.state);
        if (states.includes("CHANGES_REQUESTED")) {
          reviewDecision = "CHANGES_REQUESTED";
        } else if (states.includes("APPROVED")) {
          reviewDecision = "APPROVED";
        } else if (reviews.length > 0) {
          reviewDecision = "REVIEW_REQUIRED";
        }
      }

      let state: PullRequestPreview["state"] = "open";
      if (pr.state === "closed") {
        state = "closed";
      }

      return {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        body: pr.body ?? "",
        state,
        draft: pr.draft,
        base: pr.base.ref,
        head: pr.head.ref,
        mergeable: pr.mergeable ?? undefined,
        mergeableState: pr.mergeable_state,
        reviewDecision,
        checks,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        updatedAt: pr.updated_at,
      };
    },

    async postPRComment(repoId, prNumber, body) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const res = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        }
      );
      if (!res.ok) {
        throw new EngineError("upstream", `GitHub API error: ${res.status} ${res.statusText}`);
      }
    },

    async findPRByHead(repoId, head, base) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const params = new URLSearchParams({
        head: `${owner}:${head}`,
        state: "all",
        per_page: "1",
      });
      if (base) {
        params.set("base", base);
      }

      const res = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls?${params.toString()}`,
        token
      );
      if (!res.ok) {
        const text = await res.text();
        throw new EngineError("upstream", `GitHub API error: ${res.status} ${text}`);
      }

      const prs = (await res.json()) as GithubPRListResponse[];
      if (!Array.isArray(prs) || prs.length === 0) return null;

      const pr = prs[0]!;
      let state: FindPRResult["state"] = "open";
      if (pr.merged_at) {
        state = "merged";
      } else if (pr.state === "closed") {
        state = "closed";
      }

      return {
        number: pr.number,
        url: pr.html_url,
        state,
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
      };
    },

    async createPR(repoId, payload) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const res = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: payload.title,
            body: payload.body,
            head: payload.head,
            base: payload.base,
            draft: payload.draft ?? false,
          }),
        }
      );

      if (res.status === 422) {
        const text = await res.text();
        throw new EngineError("conflict", `PR already exists or invalid: ${text}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new EngineError("upstream", `GitHub API error: ${res.status} ${text}`);
      }

      const pr = (await res.json()) as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url };
    },

    async editPRBase(repoId, prNumber, newBase) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const res = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        token,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base: newBase }),
        }
      );

      if (!res.ok) {
        const text = await res.text();
        throw new EngineError("upstream", `GitHub API error: ${res.status} ${text}`);
      }
    },

    async mergePR(repoId, prNumber, opts) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const mergeMethodMap: Record<"merge" | "squash" | "rebase", string> = {
        merge: "merge",
        squash: "squash",
        rebase: "rebase",
      };

      const res = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        token,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merge_method: mergeMethodMap[opts.strategy] }),
        }
      );

      if (res.status === 405) {
        const text = await res.text();
        throw new EngineError("conflict", `PR not mergeable: ${text}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new EngineError("upstream", `GitHub API error: ${res.status} ${text}`);
      }

      const data = (await res.json()) as { sha: string; merged: boolean };
      return { sha: data.sha, merged: data.merged };
    },

    async getCheckRollup(repoId, ref) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const prResult = await this.findPRByHead(repoId, ref, "");
      const openPr = prResult?.state === "open" ? prResult : null;

      if (!openPr) {
        return {
          state: "pending",
          checks: [],
          mergeable: null,
          mergeStateStatus: null,
          reviewDecision: null,
          pr: null,
        };
      }

      const prRes = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${openPr.number}`,
        token
      );
      if (!prRes.ok) {
        const text = await prRes.text();
        throw new EngineError("upstream", `GitHub API error: ${prRes.status} ${text}`);
      }
      const prData = (await prRes.json()) as GithubPRResponse;
      const headSha = prData.head.sha;

      const [checkRunsRes, statusRes, reviewsRes] = await Promise.all([
        githubFetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
          token
        ),
        githubFetch(
          `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`,
          token
        ),
        githubFetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${openPr.number}/reviews`,
          token
        ),
      ]);

      const checks: GhCheck[] = [];

      if (checkRunsRes.ok) {
        const crData = (await checkRunsRes.json()) as GithubCheckRunsResponse;
        for (const cr of crData.check_runs) {
          const conclusion = (cr.conclusion ?? "").toLowerCase();
          const status = (cr.status ?? "").toLowerCase();
          const bucket: GhCheck["bucket"] = FAIL_CONCLUSIONS.has(conclusion)
            ? "fail"
            : PASS_CONCLUSIONS.has(conclusion)
              ? "pass"
              : "pending";
          checks.push({
            name: cr.name,
            state: (conclusion || status).toUpperCase(),
            bucket,
            workflow: cr.app?.name ?? "",
            link: cr.html_url ?? "",
          });
        }
      }

      if (statusRes.ok) {
        const stData = (await statusRes.json()) as GithubStatusResponse;
        for (const s of stData.statuses) {
          const state = (s.state ?? "").toLowerCase();
          const bucket: GhCheck["bucket"] = FAIL_STATES.has(state)
            ? "fail"
            : state === "success"
              ? "pass"
              : "pending";
          checks.push({
            name: s.context,
            state: state.toUpperCase(),
            bucket,
            workflow: "",
            link: s.target_url ?? "",
          });
        }
      }

      let reviewDecision: string | null = null;
      if (reviewsRes.ok) {
        const reviews = (await reviewsRes.json()) as GithubPRReviewResponse[];
        const states = reviews.map((r) => r.state);
        if (states.includes("CHANGES_REQUESTED")) {
          reviewDecision = "CHANGES_REQUESTED";
        } else if (states.includes("APPROVED")) {
          reviewDecision = "APPROVED";
        } else if (reviews.length > 0) {
          reviewDecision = "REVIEW_REQUIRED";
        }
      }

      const hasFailed = checks.some((c) => c.bucket === "fail");
      const hasPending = checks.some((c) => c.bucket === "pending");
      const rollupState: CheckRollupResult["state"] = hasFailed
        ? "failed"
        : hasPending || checks.length === 0
          ? "pending"
          : "passed";

      const mergeableStr = prData.mergeable === true
        ? "MERGEABLE"
        : prData.mergeable === false
          ? "CONFLICTING"
          : "UNKNOWN";
      const mergeStateStatus = (prData.mergeable_state ?? "").toUpperCase() || null;

      let prState: "open" | "closed" | "merged" = "open";
      if (prData.merged_at) {
        prState = "merged";
      } else if (prData.state === "closed") {
        prState = "closed";
      }

      return {
        state: rollupState,
        checks,
        mergeable: mergeableStr,
        mergeStateStatus,
        reviewDecision,
        pr: {
          number: prData.number,
          url: prData.html_url,
          state: prState,
          draft: prData.draft,
          baseRef: prData.base.ref,
          headRef: prData.head.ref,
          headSha,
          title: prData.title,
        },
      };
    },

    async fetchFailedLogs(repoId, runId) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const res = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
        token
      );

      if (!res.ok) {
        const text = await res.text();
        throw new EngineError("upstream", `GitHub API error: ${res.status} ${text}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const zip = new AdmZip(buf);
      const entries = zip.getEntries();

      const jobLogs: Record<string, string[]> = {};
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        const slashIdx = entryName.indexOf("/");
        const jobName = slashIdx >= 0 ? entryName.slice(0, slashIdx) : entryName;
        const content = entry.getData().toString("utf8");
        if (!jobLogs[jobName]) jobLogs[jobName] = [];
        jobLogs[jobName].push(content);
      }

      const logsByJob: Record<string, string> = {};
      for (const [jobName, parts] of Object.entries(jobLogs)) {
        const combined = parts.join("\n");
        const tailed = tailLines(combined, TAIL_LINES);
        logsByJob[jobName] = clipTailBytes(tailed, MAX_LOG_BYTES);
      }

      return { logsByJob };
    },

    async fetchActionsRunIdForBranch(repoId, branch) {
      const token = await getToken();
      const { owner, repo } = await resolveOwnerRepo(repoId);

      const params = new URLSearchParams({
        branch,
        status: "failure",
        per_page: "1",
      });

      const res = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs?${params.toString()}`,
        token
      );

      if (!res.ok) {
        const text = await res.text();
        throw new EngineError("upstream", `GitHub API error: ${res.status} ${text}`);
      }

      const data = (await res.json()) as GithubActionsRunsResponse;
      const runId = data.runs[0]?.id;
      return runId ? String(runId) : null;
    },
  };
}
