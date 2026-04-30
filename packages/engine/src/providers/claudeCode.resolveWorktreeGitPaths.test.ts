import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { addWorktree } from "../workspace/worktree.js";
import { createLogger } from "../logger.js";
import { resolveWorktreeGitPaths } from "./claudeCode.js";

interface Fixture {
  reposDir: string;
  worktreeRoot: string;
  repoId: string;
  cleanup: () => Promise<void>;
}

async function makeBareFixture(): Promise<Fixture> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-worktree-git-"));
  const reposDir = path.join(tmpRoot, "repos");
  const worktreeRoot = path.join(tmpRoot, "worktrees");
  await fs.mkdir(reposDir, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });

  const seedDir = path.join(tmpRoot, "seed");
  await fs.mkdir(seedDir, { recursive: true });
  const seed = simpleGit(seedDir);
  await seed.init(["--initial-branch=main"]);
  await seed.addConfig("user.email", "test@local");
  await seed.addConfig("user.name", "Test");
  await fs.writeFile(path.join(seedDir, "README.md"), "seed\n");
  await seed.add(".");
  await seed.commit("initial");

  const repoId = "repo-fixture";
  const barePath = path.join(reposDir, `${repoId}.git`);
  await simpleGit().clone(seedDir, barePath, ["--bare"]);

  const bareGit = simpleGit(barePath);
  try {
    await bareGit.raw(["remote", "add", "origin", seedDir]);
  } catch {
    /* no-op */
  }

  return {
    reposDir,
    worktreeRoot,
    repoId,
    cleanup: async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe("resolveWorktreeGitPaths", () => {
  test("returns absolute git-dir and common-dir for a linked worktree", async () => {
    const fx = await makeBareFixture();
    const log = createLogger("error");
    const slug = "resolve-paths";

    try {
      const { worktreePath } = await addWorktree(
        fx.reposDir,
        fx.worktreeRoot,
        fx.repoId,
        slug,
        "main",
        log,
      );

      const { gitDir, gitCommonDir } = await resolveWorktreeGitPaths(worktreePath);

      await fs.access(gitDir);
      await fs.access(gitCommonDir);

      const suffix = path.join(path.sep, "worktrees", slug);
      assert.ok(
        gitDir.endsWith(suffix) || gitDir.endsWith(suffix + path.sep),
        `gitDir should end with /worktrees/${slug}; got ${gitDir}`,
      );

      const barePath = path.join(fx.reposDir, `${fx.repoId}.git`);
      const realBare = await fs.realpath(barePath);
      const realGitDir = await fs.realpath(gitDir);
      assert.ok(
        realGitDir.startsWith(realBare),
        `gitDir should be under bare repo ${realBare}; got ${realGitDir}`,
      );

      const realCommon = await fs.realpath(gitCommonDir);
      assert.equal(
        realCommon,
        realBare,
        "gitCommonDir must resolve to the bare repo path itself",
      );
    } finally {
      await fx.cleanup();
    }
  });
});
