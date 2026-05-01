import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Session, RepoBinding } from "@minions/shared";
import { openStore } from "../../store/sqlite.js";
import { createLogger } from "../../logger.js";
import { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import type { EngineContext } from "../../context.js";
import { createCiFetchLogsHandler, enqueueCiFetchLogs } from "./ciFetchLogs.js";

interface MakeSessionInput {
  slug: string;
  repoId?: string;
  selfHealCi?: boolean;
}

function makeSession({ slug, repoId = "r1", selfHealCi = false }: MakeSessionInput): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: slug,
    prompt: "test",
    mode: "task",
    status: "running",
    repoId,
    attention: [],
    quickActions: [],
    stats: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
    provider: "mock",
    createdAt: now,
    updatedAt: now,
    childSlugs: [],
    metadata: selfHealCi ? { selfHealCi: true } : {},
  };
}

function makeRepo(): RepoBinding {
  return {
    id: "r1",
    label: "r1",
    remote: "https://github.com/acme/widgets.git",
    defaultBranch: "main",
  };
}

interface Env {
  db: Database.Database;
  repo: AutomationJobRepo;
  workspaceDir: string;
  cleanup: () => void;
}

function setup(): Env {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-cifetch-"));
  const dbPath = path.join(tmpDir, "test.db");
  const log = createLogger("error");
  const db = openStore({ path: dbPath, log });
  const repo = new AutomationJobRepo(db);
  return {
    db,
    repo,
    workspaceDir: tmpDir,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

interface CtxOpts {
  session: Session | null;
  repos?: RepoBinding[];
  metadataPatches: Record<string, unknown>[];
  replies: { slug: string; text: string }[];
  kicks: string[];
}

function makeCtx(opts: CtxOpts): EngineContext {
  return {
    sessions: {
      get: (slug: string) =>
        opts.session && opts.session.slug === slug ? opts.session : null,
      setMetadata: (slug: string, patch: Record<string, unknown>) => {
        opts.metadataPatches.push({ slug, ...patch });
        if (opts.session && opts.session.slug === slug) {
          opts.session.metadata = { ...opts.session.metadata, ...patch };
        }
      },
      reply: async (slug: string, text: string) => {
        opts.replies.push({ slug, text });
      },
      kickReplyQueue: async (slug: string) => {
        opts.kicks.push(slug);
        return true;
      },
    },
    repos: () => opts.repos ?? [makeRepo()],
  } as unknown as EngineContext;
}

describe("ciFetchLogs handler", () => {
  it("fetches logs, stores file, and queues a reply when self-heal is on", async () => {
    const env = setup();
    try {
      const session = makeSession({ slug: "s1", selfHealCi: true });
      const replies: { slug: string; text: string }[] = [];
      const kicks: string[] = [];
      const metadataPatches: Record<string, unknown>[] = [];
      const ctx = makeCtx({ session, metadataPatches, replies, kicks });

      const ghCalls: string[][] = [];
      const handler = createCiFetchLogsHandler({
        workspaceDir: env.workspaceDir,
        runGh: async (args) => {
          ghCalls.push(args);
          return "TypeError: cannot read x of undefined\n  at fn\n  at runner\n";
        },
      });

      const job = enqueueCiFetchLogs(env.repo, {
        sessionSlug: "s1",
        runId: "12345",
        failedJobNames: ["build", "lint"],
      });

      await handler(env.repo.get(job.id)!, ctx);

      assert.equal(ghCalls.length, 2, "should call gh once per failed job");
      for (const args of ghCalls) {
        assert.ok(args.includes("--log-failed"));
        assert.ok(args.includes("--repo"));
        assert.ok(args.includes("acme/widgets"));
      }

      const expectedPath = path.join(
        env.workspaceDir,
        ".minions",
        "ci-logs",
        "s1",
        "12345.log",
      );
      assert.ok(fs.existsSync(expectedPath), "log file should exist");
      const content = fs.readFileSync(expectedPath, "utf8");
      assert.match(content, /=== build ===/);
      assert.match(content, /=== lint ===/);
      assert.match(content, /TypeError/);

      assert.equal(metadataPatches.length, 1);
      const patch = metadataPatches[0]!;
      assert.equal(patch["slug"], "s1");
      assert.equal(patch["ciFailureLogPath"], expectedPath);
      assert.match(String(patch["ciFailureSummary"]), /TypeError/);

      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.slug, "s1");
      assert.match(replies[0]!.text, /Failure logs available at/);
      assert.match(replies[0]!.text, /First failure: TypeError/);
      assert.deepEqual(kicks, ["s1"]);
    } finally {
      env.cleanup();
    }
  });

  it("rejects path-traversal sessionSlug values", async () => {
    const env = setup();
    try {
      const ctx = makeCtx({
        session: null,
        metadataPatches: [],
        replies: [],
        kicks: [],
      });
      const handler = createCiFetchLogsHandler({
        workspaceDir: env.workspaceDir,
        runGh: async () => "",
      });

      const badSlugs = ["../etc", "evil/slug", "evil..slug", "Mixed-Case"];
      for (const bad of badSlugs) {
        const job = env.repo.enqueue({
          kind: "ci-fetch-logs",
          targetKind: "session",
          targetId: bad,
          payload: {
            sessionSlug: bad,
            runId: "1",
            failedJobNames: ["x"],
          },
        });
        await assert.rejects(
          () => handler(env.repo.get(job.id)!, ctx),
          /invalid sessionSlug/,
          `expected rejection for slug=${bad}`,
        );
      }

      const traversalDir = path.join(env.workspaceDir, ".minions", "ci-logs");
      assert.ok(
        !fs.existsSync(traversalDir),
        "no log dir should be created for invalid slugs",
      );
    } finally {
      env.cleanup();
    }
  });

  it("stores the log file but skips reply when selfHealCi is not set", async () => {
    const env = setup();
    try {
      const session = makeSession({ slug: "s2", selfHealCi: false });
      const replies: { slug: string; text: string }[] = [];
      const kicks: string[] = [];
      const metadataPatches: Record<string, unknown>[] = [];
      const ctx = makeCtx({ session, metadataPatches, replies, kicks });

      const handler = createCiFetchLogsHandler({
        workspaceDir: env.workspaceDir,
        runGh: async () => "boom: something failed\n",
      });

      const job = enqueueCiFetchLogs(env.repo, {
        sessionSlug: "s2",
        runId: "999",
        failedJobNames: ["build"],
      });

      await handler(env.repo.get(job.id)!, ctx);

      const expectedPath = path.join(
        env.workspaceDir,
        ".minions",
        "ci-logs",
        "s2",
        "999.log",
      );
      assert.ok(fs.existsSync(expectedPath), "log file should still be written");
      assert.equal(metadataPatches.length, 1);
      assert.equal(metadataPatches[0]!["ciFailureLogPath"], expectedPath);
      assert.equal(replies.length, 0, "no reply when selfHealCi is off");
      assert.equal(kicks.length, 0, "no kick when selfHealCi is off");
    } finally {
      env.cleanup();
    }
  });
});
