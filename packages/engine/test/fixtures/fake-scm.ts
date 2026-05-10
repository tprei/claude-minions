// FakeSCM: in-process SCMPlugin that does real git ops against real worktrees but keeps PR state in memory.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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
} from "../../src/plugins/scm-plugin.js";

const execFileAsync = promisify(execFile);

export interface FakePR {
  number: number;
  url: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  merged: boolean;
  mergeCommitSha?: string;
  checkRuns: Array<{ name: string; status: "queued" | "in_progress" | "completed"; conclusion?: string }>;
}

export interface FakeSCMOptions {
  rebaseBehaviour?: "clean" | "conflict";
  mergeBehaviour?: "success" | "head_sha_changed" | "not_mergeable" | "blocked";
}

export class FakeSCM implements SCMPlugin {
  readonly prsByBranch = new Map<string, FakePR>();
  readonly prsByNumber = new Map<number, FakePR>();
  rebaseBehaviour: NonNullable<FakeSCMOptions["rebaseBehaviour"]> = "clean";
  mergeBehaviour: NonNullable<FakeSCMOptions["mergeBehaviour"]> = "success";
  private nextPrNumber = 1;

  constructor(opts: FakeSCMOptions = {}) {
    this.rebaseBehaviour = opts.rebaseBehaviour ?? "clean";
    this.mergeBehaviour = opts.mergeBehaviour ?? "success";
  }

  async createBranch(path: string, branchName: string): Promise<void> {
    await execFileAsync("git", ["-C", path, "checkout", "-b", branchName]);
  }

  async commit(path: string, message: string): Promise<string> {
    await execFileAsync("git", ["-C", path, "add", "-A"]);
    await execFileAsync("git", ["-C", path, "commit", "--allow-empty", "-m", message]);
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async squashCommits(path: string, ontoBase: string, message: string): Promise<string> {
    await execFileAsync("git", ["-C", path, "reset", "--soft", ontoBase]);
    await execFileAsync("git", ["-C", path, "commit", "--allow-empty", "-m", message]);
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async rebase(path: string, onto: string): Promise<MergeResult> {
    if (this.rebaseBehaviour === "conflict") {
      return { kind: "conflict", conflictPaths: ["fake-conflict.txt"] };
    }
    try {
      await execFileAsync("git", ["-C", path, "rebase", onto]);
      return { kind: "clean" };
    } catch {
      return { kind: "conflict", conflictPaths: ["unexpected"] };
    }
  }

  async pushBranch(_path: string, _branch: string): Promise<void> {
    // no-op: no remote in integration tests
  }

  async seedTaskCommit(workspacePath: string, fileName: string, content: string): Promise<string> {
    const filePath = join(workspacePath, fileName);
    await writeFile(filePath, content);
    return await this.commit(workspacePath, `seed: ${fileName}`);
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const number = this.nextPrNumber++;
    const url = `https://fake.local/${input.owner}/${input.repo}/pull/${number}`;
    const headSha = `fakesha-${input.head}-${Date.now()}`;
    const pr: FakePR = {
      number,
      url,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      mergeable: true,
      mergeableState: "clean",
      merged: false,
      checkRuns: [],
    };
    this.prsByBranch.set(input.head, pr);
    this.prsByNumber.set(number, pr);
    return { number, url, headRef: input.head, baseRef: input.base };
  }

  async findPullRequest(input: FindPullRequestInput): Promise<PullRequestRef | null> {
    const pr = this.prsByBranch.get(input.head);
    if (!pr || pr.merged) return null;
    return { number: pr.number, url: pr.url, headRef: pr.headRef, baseRef: pr.baseRef };
  }

  async getPullRequest(input: GetPullRequestInput): Promise<PullRequestDetail> {
    const pr = this.prsByNumber.get(input.number);
    if (!pr) throw new Error(`fake: PR ${input.number} not found`);
    return {
      number: pr.number,
      url: pr.url,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeableState,
      merged: pr.merged,
      ...(pr.mergeCommitSha !== undefined ? { mergeCommitSha: pr.mergeCommitSha } : {}),
    };
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<MergeOutcome> {
    const pr = this.prsByNumber.get(input.number);
    if (!pr) throw new Error(`fake: PR ${input.number} not found`);
    if (this.mergeBehaviour === "head_sha_changed") return { merged: false, reason: "head_sha_changed" };
    if (this.mergeBehaviour === "not_mergeable") return { merged: false, reason: "not_mergeable" };
    if (this.mergeBehaviour === "blocked") return { merged: false, reason: "blocked" };
    pr.merged = true;
    pr.mergeCommitSha = `fakesha-${pr.number}-merged`;
    return { merged: true, sha: pr.mergeCommitSha };
  }

  setMergeable(branch: string, patch: Partial<Pick<FakePR, "mergeable" | "mergeableState">>): void {
    const pr = this.prsByBranch.get(branch);
    if (!pr) throw new Error(`fake: PR for branch ${branch} not found`);
    if (patch.mergeable !== undefined) pr.mergeable = patch.mergeable;
    if (patch.mergeableState !== undefined) pr.mergeableState = patch.mergeableState;
  }

  setCheckRuns(
    headSha: string,
    runs: FakePR["checkRuns"],
  ): void {
    for (const pr of this.prsByNumber.values()) {
      if (pr.headSha === headSha) pr.checkRuns = runs;
    }
  }

  getPRForBranch(branch: string): FakePR | undefined {
    return this.prsByBranch.get(branch);
  }

  getPRByNumber(n: number): FakePR | undefined {
    return this.prsByNumber.get(n);
  }
}
