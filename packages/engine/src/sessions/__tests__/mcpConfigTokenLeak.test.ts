import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { EventBus } from "../../bus/eventBus.js";
import { SessionRegistry } from "../registry.js";
import { createLogger } from "../../logger.js";
import { migrations } from "../../store/migrations.js";
import type { EngineContext } from "../../context.js";

const SECRET_TOKEN = "sk-leak-canary-9b0e0e2a-DO-NOT-COMMIT";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

function makeStubCtx(): EngineContext {
  return {
    audit: { record: () => {}, list: () => [] },
    dags: { onSessionTerminal: async () => {} },
    ship: { onTurnCompleted: async () => {} },
    env: {
      host: "127.0.0.1",
      port: 8787,
      token: SECRET_TOKEN,
    },
    memory: { renderPreamble: () => "" },
  } as unknown as EngineContext;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@minions.local",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@minions.local",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

function initWorktree(worktreePath: string): void {
  fs.mkdirSync(worktreePath, { recursive: true });
  git(worktreePath, ["init", "-q", "-b", "minions/test"]);
  fs.writeFileSync(path.join(worktreePath, "README.md"), "# work\n");
  git(worktreePath, ["add", "."]);
  git(worktreePath, ["commit", "-q", "-m", "init"]);
}

function listCommittedFiles(worktreePath: string): string[] {
  const out = git(worktreePath, ["ls-tree", "-r", "--name-only", "HEAD"]);
  return out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function callWriteMcpConfig(
  registry: SessionRegistry,
  slug: string,
  worktreePath: string,
): Promise<string> {
  const fn = (
    registry as unknown as {
      writeMcpConfig: (slug: string, worktreePath: string) => Promise<string>;
    }
  ).writeMcpConfig.bind(registry);
  return fn(slug, worktreePath);
}

describe("writeMcpConfig token-leak resistance", () => {
  let db: Database.Database;
  let bus: EventBus;
  let registry: SessionRegistry;
  let workspaceDir: string;

  beforeEach(() => {
    db = makeInMemoryDb();
    bus = new EventBus();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-leak-"));
    registry = new SessionRegistry({
      db,
      bus,
      log: createLogger("error"),
      workspaceDir,
      ctx: makeStubCtx(),
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  test("the MINIONS_TOKEN does not land in any committed file when the agent runs `git add . && git commit`", async () => {
    const slug = "leak-canary";
    const worktreePath = path.join(workspaceDir, slug);
    initWorktree(worktreePath);

    const mcpConfigPath = await callWriteMcpConfig(registry, slug, worktreePath);

    const writtenContents = fs.readFileSync(mcpConfigPath, "utf8");
    assert.ok(
      writtenContents.includes(SECRET_TOKEN),
      "sanity: writeMcpConfig must actually embed the token in the config file",
    );

    const rel = path.relative(worktreePath, mcpConfigPath);
    assert.ok(
      rel.startsWith(".."),
      `mcp config path must be outside the worktree, got ${mcpConfigPath} (rel=${rel})`,
    );

    git(worktreePath, ["add", "."]);
    const status = git(worktreePath, ["status", "--porcelain"]);
    if (status.trim().length > 0) {
      git(worktreePath, ["commit", "-q", "-m", "agent commit"]);
    }

    const tracked = listCommittedFiles(worktreePath);
    for (const rel of tracked) {
      const abs = path.join(worktreePath, rel);
      const buf = fs.readFileSync(abs);
      assert.ok(
        !buf.includes(SECRET_TOKEN),
        `committed file ${rel} contains MINIONS_TOKEN — token leak`,
      );
    }
  });

  test("the mcp config path is not inside the worktree subtree", async () => {
    const slug = "scope-check";
    const worktreePath = path.join(workspaceDir, slug);
    initWorktree(worktreePath);

    const mcpConfigPath = await callWriteMcpConfig(registry, slug, worktreePath);
    const resolvedConfig = path.resolve(mcpConfigPath);
    const resolvedWorktree = path.resolve(worktreePath) + path.sep;
    assert.ok(
      !resolvedConfig.startsWith(resolvedWorktree),
      `mcp config ${resolvedConfig} must not live under worktree ${resolvedWorktree}`,
    );
  });
});
