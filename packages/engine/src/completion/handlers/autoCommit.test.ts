import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { Session } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import {
  autoCommitHandler,
  buildAutoCommitEnv,
  commitablePathsFromStatus,
  type PnpmInstallRunner,
} from "./autoCommit.js";

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

interface BusEventCall {
  kind: string;
  [k: string]: unknown;
}

function makeRecordingContext(): { ctx: EngineContext; audits: AuditCall[]; events: BusEventCall[] } {
  const audits: AuditCall[] = [];
  const events: BusEventCall[] = [];
  const ctx = {
    runtime: { effective: () => ({}) },
    audit: {
      record: (
        actor: string,
        action: string,
        target?: { kind: string; id: string },
        detail?: Record<string, unknown>,
      ) => {
        audits.push({ actor, action, target, detail });
      },
    },
    bus: {
      emit: (ev: BusEventCall) => {
        events.push(ev);
      },
    },
  } as unknown as EngineContext;
  return { ctx, audits, events };
}

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

describe("autoCommitHandler pnpm-lockfile refresh", () => {
  test("runs pnpm install and stages refreshed lockfile when package.json changes in a pnpm repo", async () => {
    const fx = await makeWorktreeFixture();
    try {
      const wt = fx.worktreePath;

      const git = simpleGit(wt);
      await fs.writeFile(path.join(wt, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
      await fs.writeFile(path.join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await git.add(["package.json", "pnpm-lock.yaml"]);
      await git.commit("seed pnpm files");

      await fs.writeFile(
        path.join(wt, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { lodash: "^4" } }) + "\n",
      );

      let installCalls = 0;
      let installCwd: string | null = null;
      const runner: PnpmInstallRunner = async (cwd) => {
        installCalls += 1;
        installCwd = cwd;
        await fs.writeFile(
          path.join(cwd, "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\npackages:\n  lodash: '4.17.21'\n",
        );
        return { stdout: "ok", stderr: "" };
      };

      const { ctx, audits } = makeRecordingContext();
      const handler = autoCommitHandler(ctx, { runPnpmInstall: runner });
      await withScrubbedGitEnv(() => handler(makeSession(wt)));

      assert.equal(installCalls, 1, "pnpm install must run exactly once");
      assert.equal(installCwd, wt, "pnpm install must run in the worktree");

      const headPaths = (await git.raw(["show", "--name-only", "--pretty=format:", "HEAD"]))
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .sort();

      assert.deepEqual(
        headPaths,
        ["package.json", "pnpm-lock.yaml"].sort(),
        "HEAD commit must include the refreshed lockfile alongside package.json",
      );

      const refreshAudit = audits.find((a) => a.action === "session.auto-commit.lockfile-refresh");
      assert.ok(refreshAudit, "lockfile refresh audit event must be recorded");
      assert.equal(refreshAudit.detail?.ok, true);
      assert.equal(refreshAudit.detail?.stdout, "ok");
    } finally {
      await fx.cleanup();
    }
  });

  test("skips pnpm install entirely when no pnpm-lock.yaml is present", async () => {
    const fx = await makeWorktreeFixture();
    try {
      const wt = fx.worktreePath;

      const git = simpleGit(wt);
      await fs.writeFile(path.join(wt, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
      await git.add(["package.json"]);
      await git.commit("seed package.json");

      await fs.writeFile(
        path.join(wt, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { lodash: "^4" } }) + "\n",
      );

      let installCalls = 0;
      const runner: PnpmInstallRunner = async () => {
        installCalls += 1;
        return { stdout: "", stderr: "" };
      };

      const { ctx } = makeRecordingContext();
      const handler = autoCommitHandler(ctx, { runPnpmInstall: runner });
      await withScrubbedGitEnv(() => handler(makeSession(wt)));

      assert.equal(installCalls, 0, "pnpm install must not run for non-pnpm repos");

      const headPaths = (await git.raw(["show", "--name-only", "--pretty=format:", "HEAD"]))
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      assert.deepEqual(headPaths.sort(), ["package.json"], "package.json change should still be committed");
    } finally {
      await fx.cleanup();
    }
  });

  test("aborts the commit and surfaces lockfile_refresh_failed attention when pnpm install fails", async () => {
    const fx = await makeWorktreeFixture();
    try {
      const wt = fx.worktreePath;

      const git = simpleGit(wt);
      await fs.writeFile(path.join(wt, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
      await fs.writeFile(path.join(wt, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await git.add(["package.json", "pnpm-lock.yaml"]);
      await git.commit("seed pnpm files");
      const headBefore = (await git.revparse(["HEAD"])).trim();

      await fs.writeFile(
        path.join(wt, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { lodash: "^4" } }) + "\n",
      );

      const runner: PnpmInstallRunner = async () => {
        const err = new Error("ENOENT: pnpm registry unreachable") as Error & {
          stdout?: string;
          stderr?: string;
        };
        err.stdout = "";
        err.stderr = "registry connection refused";
        throw err;
      };

      const { ctx, audits, events } = makeRecordingContext();
      const handler = autoCommitHandler(ctx, { runPnpmInstall: runner });
      await withScrubbedGitEnv(() => handler(makeSession(wt)));

      const headAfter = (await git.revparse(["HEAD"])).trim();
      assert.equal(headAfter, headBefore, "HEAD must not advance when lockfile refresh fails");

      const failureAudit = audits.find(
        (a) => a.action === "session.auto-commit" && a.detail?.attention === "lockfile_refresh_failed",
      );
      assert.ok(failureAudit, "audit event must surface lockfile_refresh_failed attention");
      assert.equal(failureAudit.detail?.committed, false);
      assert.equal(failureAudit.detail?.stderr, "registry connection refused");

      const warnEvent = events.find(
        (ev) => ev.kind === "transcript_event"
          && ((ev as { event?: { level?: string; text?: string } }).event?.level === "warn")
          && ((ev as { event?: { text?: string } }).event?.text ?? "").includes("lockfile refresh failed"),
      );
      assert.ok(warnEvent, "warn transcript event must be emitted on lockfile refresh failure");
    } finally {
      await fx.cleanup();
    }
  });
});
