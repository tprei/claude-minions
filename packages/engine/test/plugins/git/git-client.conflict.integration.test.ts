import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitClient } from "../../../src/plugins/git/git-client.js";

const execFileAsync = promisify(execFile);
const HAS_GIT = process.env["MWF_HAS_GIT"] === "1";
const FILE = "value.txt";

async function git(dir: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", dir, ...args]);
}

// Builds a repo with `main` and `feature` that both rewrite the same line, then
// starts a rebase of feature onto main and leaves it conflicting (no abort).
async function repoWithLiveConflict(dir: string): Promise<void> {
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "t@t.com");
  await git(dir, "config", "user.name", "T");
  await writeFile(join(dir, FILE), "value=base\n");
  await git(dir, "add", FILE);
  await git(dir, "commit", "-m", "base");
  await git(dir, "checkout", "-b", "feature");
  await writeFile(join(dir, FILE), "value=feature\n");
  await git(dir, "commit", "-am", "feature");
  await git(dir, "checkout", "main");
  await writeFile(join(dir, FILE), "value=main\n");
  await git(dir, "commit", "-am", "main");
  await git(dir, "checkout", "feature");
  await execFileAsync("git", ["-C", dir, "rebase", "main"]).catch(() => {});
}

describe.skipIf(!HAS_GIT)("GitClient conflict primitives (real git)", () => {
  it("detects, then clears, a live rebase conflict", async () => {
    const base = await mkdtemp(join(tmpdir(), "mwf-gc-"));
    const dir = join(base, "repo");
    try {
      await execFileAsync("mkdir", ["-p", dir]);
      await repoWithLiveConflict(dir);
      const gc = new GitClient();

      expect(await gc.isRebaseInProgress(dir)).toBe(true);
      expect(await gc.listConflictedFiles(dir)).toContain(FILE);
      expect(await gc.hasConflictMarkers(dir)).toBe(true);
      expect(await gc.statusIsClean(dir)).toBe(false);

      // resolve and continue
      await writeFile(join(dir, FILE), "value=resolved\n");
      await gc.addAll(dir);
      const continued = await gc.rebaseContinue(dir);
      expect(continued.kind).toBe("clean");

      expect(await gc.isRebaseInProgress(dir)).toBe(false);
      expect(await gc.hasConflictMarkers(dir)).toBe(false);
      expect(await gc.statusIsClean(dir)).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("reports no rebase / clean tree on a fresh repo", async () => {
    const base = await mkdtemp(join(tmpdir(), "mwf-gc-"));
    const dir = join(base, "repo");
    try {
      await execFileAsync("mkdir", ["-p", dir]);
      await git(dir, "init", "-b", "main");
      await git(dir, "config", "user.email", "t@t.com");
      await git(dir, "config", "user.name", "T");
      await writeFile(join(dir, FILE), "x\n");
      await git(dir, "add", FILE);
      await git(dir, "commit", "-m", "base");
      const gc = new GitClient();

      expect(await gc.isRebaseInProgress(dir)).toBe(false);
      expect(await gc.hasConflictMarkers(dir)).toBe(false);
      expect(await gc.statusIsClean(dir)).toBe(true);
      expect(await gc.listConflictedFiles(dir)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
