import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { GitClient } from "../git/git-client.js";
import { GitError } from "../git/git-client.js";
import type { GitHubClient } from "./github-client.js";
import { GitHubApiError } from "./github-client.js";
import type {
  SCMPlugin,
  MergeResult,
  MergeOutcome,
  PullRequestRef,
  PullRequestDetail,
  OpenPullRequestInput,
  FindPullRequestInput,
  GetPullRequestInput,
  MergePullRequestInput,
} from "../scm-plugin.js";

const ASKPASS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/gh-askpass.sh",
);

export interface GitHubScmPluginDeps {
  github: GitHubClient;
  git: GitClient;
  token: string;
}

export class GitHubScmPlugin implements SCMPlugin {
  private readonly github: GitHubClient;
  private readonly git: GitClient;
  private readonly token: string;

  constructor(deps: GitHubScmPluginDeps) {
    this.github = deps.github;
    this.git = deps.git;
    this.token = deps.token;
  }

  async createBranch(path: string, branchName: string): Promise<void> {
    await this.git.run(path, ["checkout", "-b", branchName]);
  }

  async commit(path: string, message: string): Promise<string> {
    await this.git.run(path, ["add", "-A"]);
    await this.git.run(path, ["commit", "-m", message]);
    const { stdout } = await this.git.run(path, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async squashCommits(path: string, ontoBase: string, message: string): Promise<string> {
    await this.git.run(path, ["reset", "--soft", ontoBase]);
    await this.git.run(path, ["commit", "-m", message]);
    const { stdout } = await this.git.run(path, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async rebase(path: string, onto: string): Promise<MergeResult> {
    try {
      await this.git.run(path, ["rebase", onto]);
      return { kind: "clean" };
    } catch (err) {
      if (err instanceof GitError && /CONFLICT/i.test(err.stdout + err.stderr)) {
        let conflictPaths: string[] = [];
        try {
          const { stdout } = await this.git.run(path, ["diff", "--name-only", "--diff-filter=U"]);
          conflictPaths = stdout.trim().split("\n").filter(Boolean);
        } catch {
        }
        try {
          await this.git.run(path, ["rebase", "--abort"]);
        } catch {
        }
        return { kind: "conflict", conflictPaths };
      }
      throw err;
    }
  }

  async pushBranch(path: string, branch: string): Promise<void> {
    await this.git.run(path, ["push", "-u", "--force-with-lease", "origin", branch], {
      env: { GIT_ASKPASS: ASKPASS_PATH, GH_TOKEN: this.token },
    });
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const ref = await this.github.createPR(input.owner, input.repo, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    });
    return ref;
  }

  async findPullRequest(input: FindPullRequestInput): Promise<PullRequestRef | null> {
    return this.github.findPRByHead(input.owner, input.repo, input.head, input.base);
  }

  async getPullRequest(input: GetPullRequestInput): Promise<PullRequestDetail> {
    const detail = await this.github.getPR(input.owner, input.repo, input.number);
    return {
      number: detail.number,
      url: detail.url,
      headSha: detail.headSha,
      headRef: detail.headRef,
      baseRef: detail.baseRef,
      mergeable: detail.mergeable,
      mergeableState: detail.mergeableState,
      merged: detail.merged,
      ...(detail.mergeCommitSha !== undefined ? { mergeCommitSha: detail.mergeCommitSha } : {}),
    };
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<MergeOutcome> {
    try {
      const mergeOpts: import("./github-client.js").MergePROpts = {
        method: input.method ?? "squash",
      };
      if (input.expectedHeadSha !== undefined) mergeOpts.expectedHeadSha = input.expectedHeadSha;
      const result = await this.github.mergePR(input.owner, input.repo, input.number, mergeOpts);
      if (!result.merged) {
        return { merged: false, reason: "not_mergeable" };
      }
      return { merged: true, sha: result.sha };
    } catch (err) {
      if (err instanceof GitHubApiError) {
        if (err.status === 409) return { merged: false, reason: "head_sha_changed" };
        if (err.status === 405) return { merged: false, reason: "not_mergeable" };
      }
      throw err;
    }
  }
}
