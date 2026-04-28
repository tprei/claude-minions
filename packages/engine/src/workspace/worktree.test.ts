import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { addWorktree, removeWorktree } from "./worktree.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLogger } from "../logger.js";

interface Fixture {
  reposDir: string;
  worktreeRoot: string;
  repoId: string;
  cleanup: () => Promise<void>;
}

async function makeBareFixture(): Promise<Fixture> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-test-"));
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
  // Add a stub origin so addWorktree's fetch is a no-op locally; not strictly needed.
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

describe("worktree mutex", () => {
  test("two concurrent removeWorktree calls for the same slug serialize cleanly", async () => {
    const fx = await makeBareFixture();
    const log = createLogger("error");
    const mutex = new KeyedMutex();
    const slug = "race-slug";

    try {
      await addWorktree(fx.reposDir, fx.worktreeRoot, fx.repoId, slug, "main", log, mutex);
      assert.equal(mutex.isLocked(slug), false, "mutex released after add");

      const order: string[] = [];

      // Track ordering by instrumenting the mutex's run via wrapper logging in the mutex.
      // Both calls request the same key — second must await the first.
      const a = (async () => {
        order.push("a:start");
        await removeWorktree(fx.reposDir, fx.worktreeRoot, fx.repoId, slug, log, mutex);
        order.push("a:done");
      })();

      // Yield once so `a` enters the mutex first.
      await Promise.resolve();

      const b = (async () => {
        order.push("b:start");
        await removeWorktree(fx.reposDir, fx.worktreeRoot, fx.repoId, slug, log, mutex);
        order.push("b:done");
      })();

      const results = await Promise.allSettled([a, b]);

      assert.equal(results[0]?.status, "fulfilled", "first removal succeeds");
      assert.equal(results[1]?.status, "fulfilled", "second removal succeeds (idempotent under lock)");

      // Strict serialization: a must finish before b finishes.
      const aDoneIdx = order.indexOf("a:done");
      const bDoneIdx = order.indexOf("b:done");
      assert.ok(aDoneIdx >= 0 && bDoneIdx >= 0, "both completed");
      assert.ok(aDoneIdx < bDoneIdx, "first remover completes before second");

      assert.equal(mutex.isLocked(slug), false, "mutex released after both calls");

      const worktreePath = path.join(fx.worktreeRoot, slug);
      let exists = true;
      try {
        await fs.access(worktreePath);
      } catch {
        exists = false;
      }
      assert.equal(exists, false, "worktree directory cleaned up");
    } finally {
      await fx.cleanup();
    }
  });

  test("removeWorktree without mutex still works (back-compat for in-scope callers)", async () => {
    const fx = await makeBareFixture();
    const log = createLogger("error");
    const slug = "no-mutex";

    try {
      await addWorktree(fx.reposDir, fx.worktreeRoot, fx.repoId, slug, "main", log);
      await removeWorktree(fx.reposDir, fx.worktreeRoot, fx.repoId, slug, log);

      const worktreePath = path.join(fx.worktreeRoot, slug);
      let exists = true;
      try {
        await fs.access(worktreePath);
      } catch {
        exists = false;
      }
      assert.equal(exists, false, "worktree cleaned up");
    } finally {
      await fx.cleanup();
    }
  });
});
