#!/usr/bin/env node
// Usage: node scripts/prune-stale-worktrees.mjs <bareRepoPath>
// Example: node scripts/prune-stale-worktrees.mjs .dev-workspace/.repos/abc123.git

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SENTINEL_SLUG = "tvbuez38o7";
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
  const bareRepo = process.argv[2];
  if (!bareRepo) {
    console.error("Usage: node prune-stale-worktrees.mjs <bareRepoPath>");
    process.exit(1);
  }

  const worktreesDir = path.join(bareRepo, "worktrees");
  let entries;
  try {
    entries = await fs.readdir(worktreesDir);
  } catch {
    console.error(`Cannot read worktrees dir: ${worktreesDir}`);
    process.exit(1);
  }

  let scanned = 0;
  let removed = 0;
  let failed = 0;
  const now = Date.now();

  for (const slug of entries) {
    scanned++;
    if (slug === SENTINEL_SLUG) continue;

    const entryDir = path.join(worktreesDir, slug);
    const gitdirFile = path.join(entryDir, "gitdir");

    let stale = false;

    try {
      const gitdirContent = (await fs.readFile(gitdirFile, "utf8")).trim();
      const resolvedGitdir = path.resolve(entryDir, gitdirContent);
      const worktreeParent = path.dirname(resolvedGitdir);

      let parentExists = true;
      try {
        await fs.access(worktreeParent);
      } catch {
        parentExists = false;
      }

      if (!parentExists) {
        stale = true;
      } else {
        try {
          const stat = await fs.stat(worktreeParent);
          const ageMs = now - stat.mtimeMs;
          if (ageMs > STALE_THRESHOLD_MS) {
            stale = true;
          }
        } catch {
          stale = true;
        }
      }
    } catch {
      stale = true;
    }

    if (!stale) continue;

    try {
      await execFileAsync("git", ["-C", bareRepo, "worktree", "remove", "--force", slug]);
      console.log(`removed: ${slug}`);
      removed++;
    } catch (err) {
      console.error(`failed to remove ${slug}: ${err.message}`);
      failed++;
    }
  }

  try {
    await execFileAsync("git", ["-C", bareRepo, "worktree", "prune"]);
  } catch (err) {
    console.error(`worktree prune failed: ${err.message}`);
  }

  console.log(`\nSummary: scanned=${scanned} removed=${removed} failed=${failed}`);
}

main();
