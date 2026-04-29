import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { AuditEvent, PRSummary, RuntimeOverrides, Session, ServerEvent } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { autoLandHandler } from "./autoLand.js";

interface AuditRecord {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

interface OpenForReviewCall {
  slug: string;
}

interface MockCtx {
  ctx: EngineContext;
  audits: AuditRecord[];
  emitted: ServerEvent[];
  openForReviewCalls: OpenForReviewCall[];
  landCalls: { slug: string }[];
  setOverride: (overrides: RuntimeOverrides) => void;
  setOpenForReviewImpl: (impl: (call: OpenForReviewCall) => Promise<PRSummary | null>) => void;
}

function makeCtx(): MockCtx {
  const audits: AuditRecord[] = [];
  const emitted: ServerEvent[] = [];
  const openForReviewCalls: OpenForReviewCall[] = [];
  const landCalls: { slug: string }[] = [];
  let overrides: RuntimeOverrides = { autoLandOnCompletion: true };
  let openForReviewImpl: (call: OpenForReviewCall) => Promise<PRSummary | null> = async () => null;

  const ctx = {
    audit: {
      record(actor: string, action: string, target?: { kind: string; id: string }, detail?: Record<string, unknown>): void {
        audits.push({ actor, action, target, detail });
      },
      list(): AuditEvent[] {
        return [];
      },
    },
    bus: {
      emit(ev: ServerEvent): void {
        emitted.push(ev);
      },
    },
    runtime: {
      effective(): RuntimeOverrides {
        return overrides;
      },
    },
    landing: {
      async land(slug: string): Promise<void> {
        landCalls.push({ slug });
      },
      async openForReview(slug: string): Promise<PRSummary | null> {
        const call: OpenForReviewCall = { slug };
        openForReviewCalls.push(call);
        return openForReviewImpl(call);
      },
      async retryRebase(): Promise<void> {},
    },
  } as unknown as EngineContext;

  return {
    ctx,
    audits,
    emitted,
    openForReviewCalls,
    landCalls,
    setOverride(next: RuntimeOverrides): void {
      overrides = next;
    },
    setOpenForReviewImpl(impl: (call: OpenForReviewCall) => Promise<PRSummary | null>): void {
      openForReviewImpl = impl;
    },
  };
}

function makeSession(overrides: Partial<Session> & { slug: string }): Session {
  const now = new Date().toISOString();
  return {
    title: "session",
    prompt: "",
    mode: "task",
    status: "completed",
    repoId: "repo-1",
    branch: "feature",
    baseBranch: "main",
    worktreePath: "/nonexistent",
    childSlugs: [],
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
    metadata: {},
    ...overrides,
  };
}

interface RepoFixture {
  worktreePath: string;
  cleanup: () => Promise<void>;
}

async function makeRepoWithCommitsAhead(commitsAhead: number): Promise<RepoFixture> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autoland-test-"));
  const wt = path.join(tmpRoot, "wt");
  await fs.mkdir(wt, { recursive: true });
  const git = simpleGit(wt);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@local");
  await git.addConfig("user.name", "Test");
  await fs.writeFile(path.join(wt, "README.md"), "base\n");
  await git.add(".");
  await git.commit("initial");
  await git.checkoutLocalBranch("feature");
  for (let i = 0; i < commitsAhead; i++) {
    await fs.writeFile(path.join(wt, `f${i}.txt`), `${i}\n`);
    await git.add(".");
    await git.commit(`feature commit ${i}`);
  }
  return {
    worktreePath: wt,
    cleanup: async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe("autoLandHandler — skip conditions", () => {
  test("skips when status is not completed", async () => {
    const m = makeCtx();
    const handler = autoLandHandler(m.ctx);
    await handler(makeSession({ slug: "s1", status: "running" }));
    assert.equal(m.openForReviewCalls.length, 0);
    assert.equal(m.audits.length, 0);
  });

  test("skips when mode is not task", async () => {
    const m = makeCtx();
    const handler = autoLandHandler(m.ctx);
    await handler(makeSession({ slug: "s2", mode: "ship" }));
    assert.equal(m.openForReviewCalls.length, 0);
    assert.equal(m.audits.length, 0);
  });

  test("skips when worktree/branch/repo missing", async () => {
    const m = makeCtx();
    const handler = autoLandHandler(m.ctx);
    await handler(makeSession({ slug: "s3", worktreePath: undefined }));
    await handler(makeSession({ slug: "s4", branch: undefined }));
    await handler(makeSession({ slug: "s5", repoId: undefined }));
    assert.equal(m.openForReviewCalls.length, 0);
  });

  test("skips when autoLandOnCompletion is false", async () => {
    const m = makeCtx();
    m.setOverride({ autoLandOnCompletion: false });
    const handler = autoLandHandler(m.ctx);
    await handler(makeSession({ slug: "s6" }));
    assert.equal(m.openForReviewCalls.length, 0);
    assert.equal(m.audits.length, 0);
  });

  test("skips when no commits ahead of baseBranch", async () => {
    const fx = await makeRepoWithCommitsAhead(0);
    try {
      const m = makeCtx();
      const handler = autoLandHandler(m.ctx);
      await handler(makeSession({ slug: "s7", worktreePath: fx.worktreePath }));
      assert.equal(m.openForReviewCalls.length, 0, "landing.openForReview should not be called");
      assert.equal(m.audits.length, 1);
      assert.equal(m.audits[0]?.action, "session.auto-land");
      assert.equal(m.audits[0]?.detail?.["pushedAndOpened"], false);
      assert.equal(m.audits[0]?.detail?.["reason"], "no commits ahead of baseBranch");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("autoLandHandler — happy path", () => {
  test("calls landing.openForReview + records success audit when commits ahead, never merges", async () => {
    const fx = await makeRepoWithCommitsAhead(2);
    try {
      const m = makeCtx();
      const handler = autoLandHandler(m.ctx);
      await handler(makeSession({ slug: "s8", worktreePath: fx.worktreePath }));
      assert.equal(m.openForReviewCalls.length, 1);
      assert.equal(m.openForReviewCalls[0]?.slug, "s8");
      assert.equal(m.landCalls.length, 0, "auto-land must not call landing.land (no merge)");
      const successAudit = m.audits.find((a) => a.detail?.["pushedAndOpened"] === true);
      assert.ok(successAudit, "expected a success audit record");
      assert.equal(successAudit?.detail?.["baseBranch"], "main");
      assert.equal(
        successAudit?.detail?.["strategy"],
        undefined,
        "audit must not advertise a merge strategy — auto-land does not merge",
      );
    } finally {
      await fx.cleanup();
    }
  });

  test("records failure audit + warn status when landing.openForReview throws", async () => {
    const fx = await makeRepoWithCommitsAhead(1);
    try {
      const m = makeCtx();
      m.setOpenForReviewImpl(async () => {
        throw new Error("boom");
      });
      const handler = autoLandHandler(m.ctx);
      await handler(makeSession({ slug: "s9", worktreePath: fx.worktreePath }));
      assert.equal(m.openForReviewCalls.length, 1);
      const failureAudit = m.audits.find((a) => a.detail?.["pushedAndOpened"] === false);
      assert.ok(failureAudit, "expected a failure audit record");
      assert.equal(failureAudit?.detail?.["error"], "boom");
      const warnEvent = m.emitted.find(
        (e) => e.kind === "transcript_event" && e.event.kind === "status" && e.event.level === "warn",
      );
      assert.ok(warnEvent, "expected a warn status event");
    } finally {
      await fx.cleanup();
    }
  });
});
