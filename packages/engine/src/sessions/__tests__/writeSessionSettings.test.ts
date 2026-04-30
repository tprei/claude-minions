import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { addWorktree } from "../../workspace/worktree.js";
import { createLogger } from "../../logger.js";
import { writeSessionSettings } from "../writeSessionSettings.js";

interface Fixture {
  tmpRoot: string;
  reposDir: string;
  worktreeRoot: string;
  homeDir: string;
  repoId: string;
  cleanup: () => Promise<void>;
}

async function makeBareFixture(): Promise<Fixture> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-settings-"));
  const reposDir = path.join(tmpRoot, "repos");
  const worktreeRoot = path.join(tmpRoot, "worktrees");
  const homeDir = path.join(tmpRoot, "home");
  await fs.mkdir(reposDir, { recursive: true });
  await fs.mkdir(worktreeRoot, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });

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

  return {
    tmpRoot,
    reposDir,
    worktreeRoot,
    homeDir,
    repoId,
    cleanup: async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

interface Settings {
  sandbox?: {
    write?: {
      allowOnly?: string[];
    };
  };
  includeCoAuthoredBy?: boolean;
  disableWelcomeMessage?: boolean;
  disableAllHooks?: boolean;
  disableNonEssentialModelCalls?: boolean;
  bashTimeout?: number;
  bashMaxOutputLength?: number;
  apiKeyHelper?: string;
}

function assertHardeningKeys(parsed: Settings): void {
  assert.equal(parsed.includeCoAuthoredBy, false, "includeCoAuthoredBy must be false");
  assert.equal(parsed.disableWelcomeMessage, true, "disableWelcomeMessage must be true");
  assert.equal(parsed.disableAllHooks, true, "disableAllHooks must be true");
  assert.equal(
    parsed.disableNonEssentialModelCalls,
    true,
    "disableNonEssentialModelCalls must be true",
  );
  assert.equal(parsed.bashTimeout, 120000, "bashTimeout must cap Bash at 2min");
  assert.equal(
    parsed.bashMaxOutputLength,
    100000,
    "bashMaxOutputLength must cap tool output",
  );
  assert.equal(parsed.apiKeyHelper, "", "apiKeyHelper must be disabled (empty string)");
}

describe("writeSessionSettings", () => {
  test("writes <homeDir>/.claude/settings.json with worktree, gitDir, gitCommonDir in allowOnly", async () => {
    const fx = await makeBareFixture();
    const log = createLogger("error");
    const slug = "settings-bare";

    try {
      const { worktreePath } = await addWorktree(
        fx.reposDir,
        fx.worktreeRoot,
        fx.repoId,
        slug,
        "main",
        log,
      );

      await writeSessionSettings(fx.homeDir, worktreePath);

      const settingsPath = path.join(fx.homeDir, ".claude", "settings.json");
      const raw = await fs.readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Settings;

      const allowOnly = parsed.sandbox?.write?.allowOnly ?? [];
      assert.ok(allowOnly.includes(worktreePath), `allowOnly must include worktree path: ${allowOnly.join(", ")}`);

      const barePath = path.join(fx.reposDir, `${fx.repoId}.git`);
      const expectedGitDir = path.join(barePath, "worktrees", slug);
      const expectedCommonDir = barePath;

      assert.ok(
        allowOnly.some((p) => p === expectedGitDir),
        `allowOnly must include gitDir ${expectedGitDir}; got ${allowOnly.join(", ")}`,
      );
      assert.ok(
        allowOnly.some((p) => p === expectedCommonDir),
        `allowOnly must include gitCommonDir ${expectedCommonDir}; got ${allowOnly.join(", ")}`,
      );
      assert.equal(allowOnly.length, 3, "linked worktree must have 3 distinct allowOnly entries");

      assertHardeningKeys(parsed);
    } finally {
      await fx.cleanup();
    }
  });

  test("dedupes when gitDir and gitCommonDir are identical (non-linked worktree)", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "session-settings-flat-"));
    const worktreePath = path.join(tmpRoot, "wt");
    const homeDir = path.join(tmpRoot, "home");
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });

    try {
      const g = simpleGit(worktreePath);
      await g.init(["--initial-branch=main"]);
      await g.addConfig("user.email", "test@local");
      await g.addConfig("user.name", "Test");
      await fs.writeFile(path.join(worktreePath, "README.md"), "seed\n");
      await g.add(".");
      await g.commit("initial");

      await writeSessionSettings(homeDir, worktreePath);

      const settingsPath = path.join(homeDir, ".claude", "settings.json");
      const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Settings;
      const allowOnly = parsed.sandbox?.write?.allowOnly ?? [];

      assert.ok(allowOnly.includes(worktreePath), "worktree path must be present");
      const dotGit = path.join(worktreePath, ".git");
      assert.ok(allowOnly.includes(dotGit), `gitDir ${dotGit} must be present`);
      assert.equal(new Set(allowOnly).size, allowOnly.length, "allowOnly entries must be unique");

      assertHardeningKeys(parsed);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
