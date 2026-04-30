import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkDeps, mirrorWorkspace } from "./depsCache.js";
import { createLogger } from "../logger.js";

interface Fixture {
  worktree: string;
  cache: string;
  cleanup: () => Promise<void>;
}

async function makeWorkspaceFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deps-cache-test-"));
  const worktree = path.join(root, "worktree");
  const cache = path.join(root, "cache");
  await fs.mkdir(worktree, { recursive: true });

  await fs.writeFile(
    path.join(worktree, "package.json"),
    JSON.stringify({ name: "wt-root", private: true, version: "0.0.0" }, null, 2),
  );
  await fs.writeFile(path.join(worktree, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await fs.writeFile(path.join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(path.join(worktree, ".npmrc"), "save-exact=true\n");

  const pkgs = ["alpha", "beta"];
  for (const name of pkgs) {
    const pkgDir = path.join(worktree, "packages", name);
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: `@wt/${name}`, version: "0.0.0" }, null, 2),
    );
  }

  return {
    worktree,
    cache,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe("mirrorWorkspace", () => {
  test("copies root manifest, workspace yaml, lockfile, .npmrc, and per-package package.json", async () => {
    const fx = await makeWorkspaceFixture();
    try {
      const pkgDirs = await mirrorWorkspace(fx.worktree, fx.cache);

      assert.deepEqual(
        new Set(pkgDirs.map((p) => p.replace(/\\/g, "/"))),
        new Set(["packages/alpha", "packages/beta"]),
      );

      for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".npmrc"]) {
        await fs.access(path.join(fx.cache, file));
      }
      for (const name of ["alpha", "beta"]) {
        const cached = path.join(fx.cache, "packages", name, "package.json");
        const original = path.join(fx.worktree, "packages", name, "package.json");
        const [a, b] = await Promise.all([fs.readFile(cached, "utf8"), fs.readFile(original, "utf8")]);
        assert.equal(a, b, `package ${name} package.json mirrored`);
      }
    } finally {
      await fx.cleanup();
    }
  });

  test("supports inline yaml form: packages: [\"packages/*\"]", async () => {
    const fx = await makeWorkspaceFixture();
    try {
      await fs.writeFile(
        path.join(fx.worktree, "pnpm-workspace.yaml"),
        'packages: ["packages/*"]\n',
      );
      const pkgDirs = await mirrorWorkspace(fx.worktree, fx.cache);
      assert.equal(pkgDirs.length, 2);
    } finally {
      await fx.cleanup();
    }
  });

  test("returns empty when no package.json at root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deps-cache-empty-"));
    try {
      const out = await mirrorWorkspace(root, path.join(root, "cache"));
      assert.deepEqual(out, []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("linkDeps hardlinking", () => {
  test("hardlinks cache node_modules into worktree (root + per-package), preserving symlinks and inodes", async () => {
    const fx = await makeWorkspaceFixture();
    const log = createLogger("error");

    try {
      // Pre-populate the cache as if pnpm had already installed there.
      await mirrorWorkspace(fx.worktree, fx.cache);

      const cacheRootNm = path.join(fx.cache, "node_modules");
      const cachePkgStore = path.join(cacheRootNm, ".pnpm", "leftpad@1.0.0", "node_modules", "leftpad");
      await fs.mkdir(cachePkgStore, { recursive: true });
      const realFile = path.join(cachePkgStore, "index.js");
      await fs.writeFile(realFile, "module.exports = (s) => s;\n");

      // Symlink at top of node_modules (pnpm style, relative target).
      await fs.symlink(
        path.join(".pnpm", "leftpad@1.0.0", "node_modules", "leftpad"),
        path.join(cacheRootNm, "leftpad"),
      );

      // Per-package node_modules with a relative symlink up to the root store.
      const cachePkgNm = path.join(fx.cache, "packages", "alpha", "node_modules");
      await fs.mkdir(cachePkgNm, { recursive: true });
      await fs.symlink(
        path.join("..", "..", "..", "node_modules", ".pnpm", "leftpad@1.0.0", "node_modules", "leftpad"),
        path.join(cachePkgNm, "leftpad"),
      );

      await linkDeps("repo-x", fx.worktree, fx.cache, log);

      const wtRootNm = path.join(fx.worktree, "node_modules");
      const wtRealFile = path.join(wtRootNm, ".pnpm", "leftpad@1.0.0", "node_modules", "leftpad", "index.js");
      const [cs, ws] = await Promise.all([fs.stat(realFile), fs.stat(wtRealFile)]);
      assert.equal(cs.ino, ws.ino, "real file is hardlinked (same inode)");
      assert.ok(cs.nlink >= 2, "cache file has nlink>=2 after hardlink");

      const wtSymlink = path.join(wtRootNm, "leftpad");
      const lst = await fs.lstat(wtSymlink);
      assert.ok(lst.isSymbolicLink(), "top-level pnpm symlink preserved");
      assert.equal(
        await fs.readlink(wtSymlink),
        path.join(".pnpm", "leftpad@1.0.0", "node_modules", "leftpad"),
        "symlink target preserved verbatim",
      );

      const wtPkgSymlink = path.join(fx.worktree, "packages", "alpha", "node_modules", "leftpad");
      const pkgLst = await fs.lstat(wtPkgSymlink);
      assert.ok(pkgLst.isSymbolicLink(), "per-package node_modules symlink hardlinked into worktree");
    } finally {
      await fx.cleanup();
    }
  });
});
