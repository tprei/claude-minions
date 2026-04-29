import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { Session } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { autoCommitHandler, buildAutoCommitEnv, commitablePathsFromStatus } from "./autoCommit.js";

describe("buildAutoCommitEnv", () => {
  test("strips editor env vars even when set in the source environment", () => {
    const env = buildAutoCommitEnv({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_EDITOR: "true",
      EDITOR: "vim",
      GIT_SEQUENCE_EDITOR: "vim",
      GIT_PAGER: "less",
    });

    assert.equal(env.GIT_EDITOR, undefined, "GIT_EDITOR must not propagate to git subprocess");
    assert.equal(env.EDITOR, undefined, "EDITOR must not propagate to git subprocess");
    assert.equal(env.GIT_SEQUENCE_EDITOR, undefined, "GIT_SEQUENCE_EDITOR must not propagate");
    assert.equal(env.GIT_PAGER, undefined, "GIT_PAGER must not propagate");
  });

  test("preserves non-editor env vars", () => {
    const env = buildAutoCommitEnv({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_EDITOR: "true",
      CUSTOM_VAR: "kept",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/test");
    assert.equal(env.CUSTOM_VAR, "kept");
  });

  test("sets author and committer identity for the engine", () => {
    const env = buildAutoCommitEnv({});

    assert.equal(env.GIT_AUTHOR_NAME, "minions-engine");
    assert.equal(env.GIT_AUTHOR_EMAIL, "engine@minions.local");
    assert.equal(env.GIT_COMMITTER_NAME, "minions-engine");
    assert.equal(env.GIT_COMMITTER_EMAIL, "engine@minions.local");
  });

  test("identity overrides any inherited GIT_AUTHOR_*/GIT_COMMITTER_* values", () => {
    const env = buildAutoCommitEnv({
      GIT_AUTHOR_NAME: "external",
      GIT_AUTHOR_EMAIL: "external@example.com",
      GIT_COMMITTER_NAME: "external",
      GIT_COMMITTER_EMAIL: "external@example.com",
    });

    assert.equal(env.GIT_AUTHOR_NAME, "minions-engine");
    assert.equal(env.GIT_AUTHOR_EMAIL, "engine@minions.local");
    assert.equal(env.GIT_COMMITTER_NAME, "minions-engine");
    assert.equal(env.GIT_COMMITTER_EMAIL, "engine@minions.local");
  });
});

describe("commitablePathsFromStatus", () => {
  test("filters injected assets and dedupes across not_added/modified/created", () => {
    const status = {
      not_added: ["AGENTS.md", "CLAUDE.md", "instructions.md", ".cursor/rules/instructions.md", "src/new.ts"],
      modified: ["src/new.ts", "README.md"],
      created: [".minions/tmp/log.txt", "docs/added.md"],
      deleted: [],
      renamed: [],
      staged: [],
      files: [],
      conflicted: [],
      ahead: 0,
      behind: 0,
      current: null,
      tracking: null,
      detached: false,
      isClean: () => false,
    } as unknown as import("simple-git").StatusResult;

    const result = commitablePathsFromStatus(status);
    assert.deepEqual(result.sort(), ["README.md", "docs/added.md", "src/new.ts"].sort());
  });

  test("returns empty when only injected assets are present", () => {
    const status = {
      not_added: ["AGENTS.md", "CLAUDE.md", "instructions.md", ".cursor/rules/instructions.md"],
      modified: [],
      created: [],
      deleted: [],
      renamed: [],
      staged: [],
      files: [],
      conflicted: [],
      ahead: 0,
      behind: 0,
      current: null,
      tracking: null,
      detached: false,
      isClean: () => false,
    } as unknown as import("simple-git").StatusResult;

    assert.deepEqual(commitablePathsFromStatus(status), []);
  });
});

interface AutoCommitFixture {
  worktreePath: string;
  cleanup: () => Promise<void>;
}

async function makeWorktreeFixture(): Promise<AutoCommitFixture> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auto-commit-test-"));
  const worktreePath = path.join(tmpRoot, "wt");
  await fs.mkdir(worktreePath, { recursive: true });

  const git = simpleGit(worktreePath);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "seed@local");
  await git.addConfig("user.name", "Seed");
  await fs.writeFile(path.join(worktreePath, "README.md"), "seed\n");
  await git.add(["README.md"]);
  await git.commit("initial");

  return {
    worktreePath,
    cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }),
  };
}

// simple-git refuses to spawn a child process when GIT_SSH_COMMAND is set in the
// passed env. The test runner may inherit this from its parent shell, so scrub
// it for the integration tests below.
const UNSAFE_GIT_ENV_KEYS = ["GIT_SSH_COMMAND", "GIT_SSL_NO_VERIFY"] as const;
function withScrubbedGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of UNSAFE_GIT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function makeSession(worktreePath: string): Session {
  return {
    slug: "test-slug",
    title: "fixture session",
    prompt: "",
    mode: "open" as Session["mode"],
    status: "completed",
    repoId: "fixture-repo",
    branch: "main",
    worktreePath,
    childSlugs: [],
    attention: [],
    quickActions: [],
    stats: { turns: 0, tokensIn: 0, tokensOut: 0 } as unknown as Session["stats"],
    provider: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

function makeContext(): EngineContext {
  return {
    runtime: { effective: () => ({}) },
    audit: { record: () => {} },
    bus: { emit: () => {} },
  } as unknown as EngineContext;
}

describe("autoCommitHandler integration", () => {
  test("commits only non-injected files when both real changes and injected assets are present", async () => {
    const fx = await makeWorktreeFixture();
    try {
      const wt = fx.worktreePath;

      await fs.writeFile(path.join(wt, "feature.ts"), "export const x = 1;\n");
      await fs.writeFile(path.join(wt, "AGENTS.md"), "injected\n");
      await fs.writeFile(path.join(wt, "CLAUDE.md"), "injected\n");
      await fs.writeFile(path.join(wt, "instructions.md"), "injected\n");
      await fs.mkdir(path.join(wt, ".cursor", "rules"), { recursive: true });
      await fs.writeFile(path.join(wt, ".cursor", "rules", "instructions.md"), "injected\n");

      const handler = autoCommitHandler(makeContext());
      await withScrubbedGitEnv(() => handler(makeSession(wt)));

      const git = simpleGit(wt);
      const headPaths = (await git.raw(["show", "--name-only", "--pretty=format:", "HEAD"]))
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      assert.deepEqual(headPaths.sort(), ["feature.ts"], "HEAD commit must contain only the real change");

      const status = await git.status();
      const stillUntracked = status.not_added.sort();
      assert.deepEqual(
        stillUntracked,
        ["AGENTS.md", "CLAUDE.md", ".cursor/rules/instructions.md", "instructions.md"].sort(),
        "injected assets must remain untracked after auto-commit",
      );
    } finally {
      await fx.cleanup();
    }
  });

  test("skips commit entirely when only injected assets are present", async () => {
    const fx = await makeWorktreeFixture();
    try {
      const wt = fx.worktreePath;

      await fs.writeFile(path.join(wt, "AGENTS.md"), "injected\n");
      await fs.writeFile(path.join(wt, "CLAUDE.md"), "injected\n");
      await fs.writeFile(path.join(wt, "instructions.md"), "injected\n");

      const git = simpleGit(wt);
      const headBefore = (await git.revparse(["HEAD"])).trim();

      const handler = autoCommitHandler(makeContext());
      await withScrubbedGitEnv(() => handler(makeSession(wt)));

      const headAfter = (await git.revparse(["HEAD"])).trim();
      assert.equal(headAfter, headBefore, "HEAD must not advance when only injected assets are present");
    } finally {
      await fx.cleanup();
    }
  });
});
