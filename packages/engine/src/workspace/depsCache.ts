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

async function hardlinkTree(src: string, dst: string): Promise<void> {
  // `cp -al` (archive + hardlink) replicates the tree with hardlinks for files
  // and copies for symlinks/dirs in a single syscall path. Orders of magnitude
  // faster than the per-entry Node loop on large node_modules trees (>10k files).
  await ensureDir(path.dirname(dst));
  await new Promise<void>((resolve, reject) => {
    const child = spawn("cp", ["-al", src, dst], { stdio: "ignore" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cp -al ${src} ${dst} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function parseWorkspacePackagesYaml(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split("\n");
  let inPackages = false;
  for (const raw of lines) {
    const stripped = raw.replace(/#.*$/, "");
    if (!stripped.trim()) continue;
    const headerMatch = /^packages\s*:(.*)$/.exec(stripped);
    if (headerMatch) {
      const after = headerMatch[1]!.trim();
      if (after.startsWith("[")) {
        // Inline form: packages: ["a", "b/*"]
        const inner = after.replace(/^\[|\]$/g, "");
        for (const item of inner.split(",")) {
          const v = item.trim().replace(/^['"]|['"]$/g, "");
          if (v) patterns.push(v);
        }
        inPackages = false;
      } else {
        inPackages = true;
      }
      continue;
    }
    if (!inPackages) continue;
    if (!/^\s/.test(raw)) {
      inPackages = false;
      continue;
    }
    const itemMatch = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(stripped);
    if (itemMatch) patterns.push(itemMatch[1]!);
  }
  return patterns;
}

async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const parts = pattern.replace(/\\/g, "/").split("/").filter((p) => p.length > 0);
  let dirs: string[] = [root];
  for (const part of parts) {
    if (part === "**") {
      // Not commonly used in pnpm-workspace.yaml; bail out to keep behavior predictable.
      return [];
    }
    if (part.includes("*")) {
      const re = new RegExp(
        "^" + part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      const next: string[] = [];
      for (const d of dirs) {
        try {
          const entries = await fs.readdir(d, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory() && re.test(e.name)) next.push(path.join(d, e.name));
          }
        } catch {
          /* skip */
        }
      }
      dirs = next;
    } else {
      dirs = dirs.map((d) => path.join(d, part));
    }
  }
  const out: string[] = [];
  for (const d of dirs) {
    if (await pathExists(d)) out.push(d);
  }
  return out;
}

async function copyIfPresent(src: string, dst: string): Promise<boolean> {
  if (!(await pathExists(src))) return false;
  await ensureDir(path.dirname(dst));
  await fs.copyFile(src, dst);
  return true;
}

/**
 * Replicates the workspace shape (root manifest, pnpm-workspace.yaml, lockfile,
 * .npmrc, and each workspace package's package.json) from `worktreePath` into
 * `cacheDir`. Without these, pnpm can't resolve workspace deps inside the
 * cache and either errors out or — worse — walks up and reuses an unrelated
 * parent workspace, leaving `cacheDir/node_modules` empty.
 *
 * Returns the workspace package directories (relative to root) that were
 * mirrored, so callers can hardlink each one's node_modules back.
 */
export async function mirrorWorkspace(
  worktreePath: string,
  cacheDir: string,
): Promise<string[]> {
  await ensureDir(cacheDir);
  const rootPkg = path.join(worktreePath, "package.json");
  if (!(await pathExists(rootPkg))) return [];

  await fs.copyFile(rootPkg, path.join(cacheDir, "package.json"));
  await copyIfPresent(path.join(worktreePath, "pnpm-lock.yaml"), path.join(cacheDir, "pnpm-lock.yaml"));
  await copyIfPresent(path.join(worktreePath, ".npmrc"), path.join(cacheDir, ".npmrc"));

  const wsYaml = path.join(worktreePath, "pnpm-workspace.yaml");
  const hasWorkspace = await pathExists(wsYaml);
  if (!hasWorkspace) return [];

  const yamlText = await fs.readFile(wsYaml, "utf8");
  await fs.writeFile(path.join(cacheDir, "pnpm-workspace.yaml"), yamlText);

  const patterns = parseWorkspacePackagesYaml(yamlText);
  const relPkgDirs: string[] = [];
  for (const pattern of patterns) {
    const matches = await expandPattern(worktreePath, pattern);
    for (const abs of matches) {
      const pkgJson = path.join(abs, "package.json");
      if (!(await pathExists(pkgJson))) continue;
      const rel = path.relative(worktreePath, abs);
      relPkgDirs.push(rel);
      const dstDir = path.join(cacheDir, rel);
      await ensureDir(dstDir);
      await fs.copyFile(pkgJson, path.join(dstDir, "package.json"));
      // Also mirror per-package .npmrc when present.
      await copyIfPresent(path.join(abs, ".npmrc"), path.join(dstDir, ".npmrc"));
    }
  }
  return relPkgDirs;
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

  let pkgDirs: string[] = [];
  if (!(await pathExists(cacheNodeModules))) {
    log.info("building deps cache", { repoId, depsCache });
    try {
      pkgDirs = await mirrorWorkspace(worktreePath, depsCache);
      await runCommand("pnpm", ["install", "--frozen-lockfile"], depsCache);
    } catch (err) {
      log.warn("pnpm install failed for deps cache", { repoId, err: String(err) });
      return;
    }
  } else {
    // Cache already populated from a prior session — re-derive package dirs so
    // we know which per-package node_modules to hardlink.
    const wsYaml = path.join(depsCache, "pnpm-workspace.yaml");
    if (await pathExists(wsYaml)) {
      const patterns = parseWorkspacePackagesYaml(await fs.readFile(wsYaml, "utf8"));
      for (const pattern of patterns) {
        const matches = await expandPattern(depsCache, pattern);
        for (const abs of matches) {
          if (await pathExists(path.join(abs, "package.json"))) {
            pkgDirs.push(path.relative(depsCache, abs));
          }
        }
      }
    }
  }

  if (!(await pathExists(cacheNodeModules))) {
    log.warn("deps cache produced no node_modules; skipping hardlink", { repoId, depsCache });
    return;
  }

  if (!(await pathExists(worktreeNodeModules))) {
    log.info("hardlinking node_modules from cache", { repoId, worktreePath });
    await hardlinkTree(cacheNodeModules, worktreeNodeModules);
  }

  for (const rel of pkgDirs) {
    const src = path.join(depsCache, rel, "node_modules");
    const dst = path.join(worktreePath, rel, "node_modules");
    if (!(await pathExists(src))) continue;
    if (await pathExists(dst)) continue;
    await hardlinkTree(src, dst);
  }
}
