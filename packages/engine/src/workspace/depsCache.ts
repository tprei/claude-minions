import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathExists, ensureDir } from "../util/fs.js";
import type { Logger } from "../logger.js";

async function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function hardlinkDir(src: string, dst: string): Promise<void> {
  await ensureDir(dst);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await hardlinkDir(srcPath, dstPath);
    } else if (entry.isFile()) {
      if (!(await pathExists(dstPath))) {
        try {
          await fs.link(srcPath, dstPath);
        } catch {
          await fs.copyFile(srcPath, dstPath);
        }
      }
    }
  }
}

export async function linkDeps(
  repoId: string,
  worktreePath: string,
  depsCache: string,
  log: Logger,
): Promise<void> {
  const pkgJson = path.join(worktreePath, "package.json");
  if (!(await pathExists(pkgJson))) {
    log.debug("no package.json, skipping deps link", { worktreePath });
    return;
  }

  const cacheNodeModules = path.join(depsCache, "node_modules");
  const worktreeNodeModules = path.join(worktreePath, "node_modules");

  if (!(await pathExists(cacheNodeModules))) {
    log.info("building deps cache", { repoId, depsCache });
    await ensureDir(depsCache);
    try {
      await fs.copyFile(pkgJson, path.join(depsCache, "package.json"));
      const lockFile = path.join(worktreePath, "pnpm-lock.yaml");
      if (await pathExists(lockFile)) {
        await fs.copyFile(lockFile, path.join(depsCache, "pnpm-lock.yaml"));
      }
      await runCommand("pnpm", ["install", "--frozen-lockfile"], depsCache);
    } catch (err) {
      log.warn("pnpm install failed for deps cache", { repoId, err: String(err) });
      return;
    }
  }

  if (!(await pathExists(cacheNodeModules))) {
    log.warn("deps cache produced no node_modules; skipping hardlink", { repoId, depsCache });
    return;
  }

  if (!(await pathExists(worktreeNodeModules))) {
    log.info("hardlinking node_modules from cache", { repoId, worktreePath });
    await hardlinkDir(cacheNodeModules, worktreeNodeModules);
  }
}
