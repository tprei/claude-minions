import type { PullRequestPreview, CheckRun, CheckConclusion } from "@minions/shared";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";
import { EngineError } from "../errors.js";
import { RepoRepo } from "../store/repos/repoRepo.js";
import { parseGithubRemote } from "./parseRemote.js";

export interface GithubSubsystemDeps {
  db: Database.Database;
  log: Logger;
  githubToken: string | null;
}

export interface GithubSubsystem {
  enabled: () => boolean;
  fetchPR: (repoId: string, prNumber: number) => Promise<PullRequestPreview>;
  postPRComment: (repoId: string, prNumber: number, body: string) => Promise<void>;
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
  }[];
}

interface GithubPRReviewResponse {
  state: string;
}

async function githubFetch(url: string, token: string, opts?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts?.headers ?? {}),
    },
  });
  return res;
}

export function createGithubSubsystem(deps: GithubSubsystemDeps): GithubSubsystem {
  const repoRepo = new RepoRepo(deps.db);

  function requireToken(): string {
    if (!deps.githubToken) {
      throw new EngineError("unauthorized", "GITHUB_TOKEN not configured");
    }
    return deps.githubToken;
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
      return deps.githubToken !== null && deps.githubToken !== "";
    },

    async fetchPR(repoId, prNumber) {
      const token = requireToken();
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
      const token = requireToken();
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
  };
}
