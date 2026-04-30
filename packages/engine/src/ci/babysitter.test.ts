import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Session, SessionStatus, AttentionFlag, PRSummary } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { CiBabysitter } from "./babysitter.js";
import { createLogger } from "../logger.js";

interface MakeSessionInput {
  slug: string;
  status?: SessionStatus;
  pr?: PRSummary | undefined;
  attention?: AttentionFlag[];
}

function makeSession({ slug, status = "running", pr, attention = [] }: MakeSessionInput): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: slug,
    prompt: "test",
    mode: "task",
    status,
    pr,
    attention,
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
    metadata: {},
  };
}

function openPr(number: number): PRSummary {
  return {
    number,
    url: `https://example.test/pr/${number}`,
    state: "open",
    draft: false,
    base: "main",
    head: `feature-${number}`,
    title: `PR ${number}`,
  };
}

function makeCtx(sessions: Session[], polled: string[]): EngineContext {
  return {
    sessions: {
      list: () => sessions,
    } as unknown as EngineContext["sessions"],
    ci: {
      poll: async (slug: string) => {
        polled.push(slug);
      },
      onPrUpdated: async () => {},
    },
  } as unknown as EngineContext;
}

describe("CiBabysitter.pollAll", () => {
  test("polls running sessions with open PR and no terminal CI", async () => {
    const sessions = [
      makeSession({ slug: "s-running", status: "running", pr: openPr(1) }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled, ["s-running"]);
  });

  test("polls completed sessions whose PR is still open and CI not terminal", async () => {
    const sessions = [
      makeSession({ slug: "s-completed", status: "completed", pr: openPr(2) }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled, ["s-completed"]);
  });

  test("polls sessions with ci_failed attention if their PR is still open", async () => {
    const sessions = [
      makeSession({
        slug: "s-fail",
        status: "completed",
        pr: openPr(3),
        attention: [{ kind: "ci_failed", message: "boom", raisedAt: new Date().toISOString() }],
      }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled, ["s-fail"]);
  });

  test("polls sessions with ci_passed attention if their PR is still open", async () => {
    const sessions = [
      makeSession({
        slug: "s-pass",
        status: "completed",
        pr: openPr(4),
        attention: [{ kind: "ci_passed", message: "green", raisedAt: new Date().toISOString() }],
      }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled, ["s-pass"]);
  });

  test("skips sessions without a PR or with a closed/merged PR", async () => {
    const merged = openPr(5);
    merged.state = "merged";
    const closed = openPr(6);
    closed.state = "closed";
    const sessions = [
      makeSession({ slug: "no-pr", status: "running" }),
      makeSession({ slug: "merged", status: "completed", pr: merged }),
      makeSession({ slug: "closed", status: "completed", pr: closed }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled, []);
  });

  test("skips a session whose PR was merged even if it has ci_failed attention", async () => {
    const merged = openPr(12);
    merged.state = "merged";
    const sessions = [
      makeSession({
        slug: "merged-with-fail",
        status: "completed",
        pr: merged,
        attention: [{ kind: "ci_failed", message: "old", raisedAt: new Date().toISOString() }],
      }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled, []);
  });

  test("skips failed and cancelled sessions even with open PR", async () => {
    const sessions = [
      makeSession({ slug: "s-failed", status: "failed", pr: openPr(7) }),
      makeSession({ slug: "s-cancelled", status: "cancelled", pr: openPr(8) }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled, []);
  });

  test("polls a mix correctly, completed PR included alongside running", async () => {
    const sessions = [
      makeSession({ slug: "running", status: "running", pr: openPr(9) }),
      makeSession({ slug: "completed", status: "completed", pr: openPr(10) }),
      makeSession({ slug: "failed", status: "failed", pr: openPr(11) }),
    ];
    const polled: string[] = [];
    const bs = new CiBabysitter(makeCtx(sessions, polled), createLogger("error"));
    await bs.pollAll();
    assert.deepEqual(polled.sort(), ["completed", "running"]);
  });
});
