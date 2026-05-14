import { describe, expect, it, vi } from "vitest";
import { GitHubScmPlugin } from "../../../src/plugins/github/github-scm-plugin.js";
import { GitError } from "../../../src/plugins/git/git-client.js";
import type { GitClient } from "../../../src/plugins/git/git-client.js";
import type { GitHubClient } from "../../../src/plugins/github/github-client.js";

function makeGithub(): GitHubClient {
  return {
    createPR: vi.fn(),
    findPRByHead: vi.fn(),
    getPR: vi.fn(),
    mergePR: vi.fn(),
    listCheckRuns: vi.fn(),
  } as unknown as GitHubClient;
}

function makeGit(run: ReturnType<typeof vi.fn>): GitClient {
  return { run } as unknown as GitClient;
}

describe("GitHubScmPlugin", () => {
  it("pushBranch fetches and retries once after stale-info rejection", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new GitError("git exited with code 1", "", "! [rejected] feature -> feature (fetch first)", 1))
      .mockResolvedValue({ stdout: "", stderr: "" });
    const scm = new GitHubScmPlugin({ github: makeGithub(), git: makeGit(run), token: "tok" });

    await expect(scm.pushBranch("/repo", "feature")).resolves.toBeUndefined();

    expect(run).toHaveBeenNthCalledWith(1, "/repo", ["push", "-u", "--force-with-lease", "origin", "feature"], expect.objectContaining({
      env: expect.objectContaining({ GH_TOKEN: "tok" }),
    }));
    expect(run).toHaveBeenNthCalledWith(2, "/repo", ["fetch", "origin", "feature"], expect.objectContaining({
      env: expect.objectContaining({ GH_TOKEN: "tok" }),
    }));
    expect(run).toHaveBeenNthCalledWith(3, "/repo", ["push", "-u", "--force-with-lease", "origin", "feature"], expect.objectContaining({
      env: expect.objectContaining({ GH_TOKEN: "tok" }),
    }));
  });

  it("pushBranch rethrows when retry after stale-info rejection also fails", async () => {
    const retryError = new GitError("git exited with code 1", "", "! [rejected] feature -> feature (fetch first)", 1);
    const run = vi.fn()
      .mockRejectedValueOnce(new GitError("git exited with code 1", "", "! [rejected] feature -> feature (fetch first)", 1))
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(retryError);
    const scm = new GitHubScmPlugin({ github: makeGithub(), git: makeGit(run), token: "tok" });

    await expect(scm.pushBranch("/repo", "feature")).rejects.toBe(retryError);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("pushBranch does not fetch for unrelated git failures", async () => {
    const authError = new GitError("git exited with code 128", "", "Authentication failed", 128);
    const run = vi.fn().mockRejectedValue(authError);
    const scm = new GitHubScmPlugin({ github: makeGithub(), git: makeGit(run), token: "tok" });

    await expect(scm.pushBranch("/repo", "feature")).rejects.toBe(authError);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
