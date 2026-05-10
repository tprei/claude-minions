// FakeGitHubClient: duck-typed GitHubClient that reads PR/check state from FakeSCM in-memory state.
import type { GitHubClient, GhPRDetail, GhCheckRun } from "../../src/plugins/github/github-client.js";
import type { FakeSCM } from "./fake-scm.js";

export class FakeGitHubClient {
  constructor(private readonly scm: FakeSCM) {}

  async getPR(_owner: string, _repo: string, number: number): Promise<GhPRDetail> {
    const pr = this.scm.getPRByNumber(number);
    if (!pr) throw new Error(`fake-gh: PR ${number} not found`);
    return {
      number: pr.number,
      url: pr.url,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeableState,
      state: pr.merged ? "closed" : "open",
      merged: pr.merged,
      ...(pr.mergeCommitSha !== undefined ? { mergeCommitSha: pr.mergeCommitSha } : {}),
    };
  }

  async listCheckRuns(_owner: string, _repo: string, headSha: string): Promise<GhCheckRun[]> {
    for (const pr of this.scm.prsByNumber.values()) {
      if (pr.headSha === headSha) {
        return pr.checkRuns.map((r) => {
          const run: GhCheckRun = { name: r.name, status: r.status };
          const conclusion = r.conclusion as Exclude<GhCheckRun["conclusion"], undefined> | undefined;
          if (conclusion !== undefined) run.conclusion = conclusion;
          return run;
        });
      }
    }
    return [];
  }
}

export function asGitHubClient(fake: FakeGitHubClient): GitHubClient {
  return fake as unknown as GitHubClient;
}
