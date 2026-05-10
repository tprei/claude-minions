export type MergeResult =
  | { kind: "clean" }
  | { kind: "conflict"; conflictPaths: string[] };

export type MergeOutcome =
  | { merged: true; sha: string }
  | { merged: false; reason: "head_sha_changed" | "not_mergeable" | "blocked" };

export interface PullRequestRef {
  number: number;
  url: string;
  headRef: string;
  baseRef: string;
}

export interface PullRequestDetail {
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  merged: boolean;
  mergeCommitSha?: string;
}

export interface OpenPullRequestInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface FindPullRequestInput {
  owner: string;
  repo: string;
  head: string;
  base: string;
}

export interface GetPullRequestInput {
  owner: string;
  repo: string;
  number: number;
}

export interface MergePullRequestInput {
  owner: string;
  repo: string;
  number: number;
  expectedHeadSha?: string;
  method?: "merge" | "squash" | "rebase";
}

export interface SCMPlugin {
  createBranch(path: string, branchName: string): Promise<void>;
  commit(path: string, message: string): Promise<string>;
  squashCommits(path: string, ontoBase: string, message: string): Promise<string>;
  rebase(path: string, onto: string): Promise<MergeResult>;

  pushBranch(path: string, branch: string): Promise<void>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef>;
  findPullRequest(input: FindPullRequestInput): Promise<PullRequestRef | null>;
  getPullRequest(input: GetPullRequestInput): Promise<PullRequestDetail>;
  mergePullRequest(input: MergePullRequestInput): Promise<MergeOutcome>;
}
