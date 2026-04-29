import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Session, SessionStatus, PRSummary, ServerEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { onPrUpdated } from "./prLifecycle.js";
import { createLogger } from "../logger.js";

interface MakeSessionInput {
  slug: string;
  status: SessionStatus;
  pr?: PRSummary | undefined;
}

function makeSession({ slug, status, pr }: MakeSessionInput): Session {
  const now = new Date().toISOString();
  return {
    slug,
    title: slug,
    prompt: "test",
    mode: "task",
    status,
    pr,
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
    metadata: {},
  };
}

function mergedPr(number: number): PRSummary {
  return {
    number,
    url: `https://example.test/pr/${number}`,
    state: "merged",
    draft: false,
    base: "main",
    head: `feature-${number}`,
    title: `PR ${number}`,
  };
}

function closedPr(number: number): PRSummary {
  return {
    number,
    url: `https://example.test/pr/${number}`,
    state: "closed",
    draft: false,
    base: "main",
    head: `feature-${number}`,
    title: `PR ${number}`,
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

interface CtxRecording {
  ctx: EngineContext;
  stopCalls: { slug: string; reason?: string }[];
  emitted: ServerEvent[];
}

function makeCtx(session: Session): CtxRecording {
  const stopCalls: { slug: string; reason?: string }[] = [];
  const emitted: ServerEvent[] = [];
  const ctx = {
    sessions: {
      get: (slug: string) => (slug === session.slug ? session : null),
      stop: async (slug: string, reason?: string) => {
        stopCalls.push({ slug, reason });
      },
    } as unknown as EngineContext["sessions"],
    bus: {
      emit: (event: ServerEvent) => {
        emitted.push(event);
      },
    } as unknown as EngineContext["bus"],
  } as unknown as EngineContext;
  return { ctx, stopCalls, emitted };
}

describe("onPrUpdated", () => {
  test("does not stop a completed session whose PR was merged", async () => {
    const session = makeSession({ slug: "s-completed", status: "completed", pr: mergedPr(1) });
    const { ctx, stopCalls, emitted } = makeCtx(session);

    await onPrUpdated("s-completed", ctx, createLogger("error"));

    assert.equal(stopCalls.length, 0);
    assert.equal(session.status, "completed");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.kind, "session_updated");
  });

  test("does not stop a failed session whose PR was closed", async () => {
    const session = makeSession({ slug: "s-failed", status: "failed", pr: closedPr(2) });
    const { ctx, stopCalls, emitted } = makeCtx(session);

    await onPrUpdated("s-failed", ctx, createLogger("error"));

    assert.equal(stopCalls.length, 0);
    assert.equal(session.status, "failed");
    assert.equal(emitted.length, 1);
  });

  test("does not stop an already-cancelled session whose PR was merged", async () => {
    const session = makeSession({ slug: "s-cancelled", status: "cancelled", pr: mergedPr(3) });
    const { ctx, stopCalls } = makeCtx(session);

    await onPrUpdated("s-cancelled", ctx, createLogger("error"));

    assert.equal(stopCalls.length, 0);
  });

  test("stops a running session whose PR was merged", async () => {
    const session = makeSession({ slug: "s-running", status: "running", pr: mergedPr(4) });
    const { ctx, stopCalls, emitted } = makeCtx(session);

    await onPrUpdated("s-running", ctx, createLogger("error"));

    assert.equal(stopCalls.length, 1);
    assert.equal(stopCalls[0]?.slug, "s-running");
    assert.equal(stopCalls[0]?.reason, "PR merged");
    assert.equal(emitted.length, 1);
  });

  test("stops a waiting_input session whose PR was closed", async () => {
    const session = makeSession({ slug: "s-wait", status: "waiting_input", pr: closedPr(5) });
    const { ctx, stopCalls } = makeCtx(session);

    await onPrUpdated("s-wait", ctx, createLogger("error"));

    assert.equal(stopCalls.length, 1);
    assert.equal(stopCalls[0]?.reason, "PR closed");
  });

  test("does nothing for a session with an open PR", async () => {
    const session = makeSession({ slug: "s-open", status: "running", pr: openPr(6) });
    const { ctx, stopCalls, emitted } = makeCtx(session);

    await onPrUpdated("s-open", ctx, createLogger("error"));

    assert.equal(stopCalls.length, 0);
    assert.equal(emitted.length, 0);
  });

  test("does nothing for a session without a PR", async () => {
    const session = makeSession({ slug: "s-no-pr", status: "running" });
    const { ctx, stopCalls, emitted } = makeCtx(session);

    await onPrUpdated("s-no-pr", ctx, createLogger("error"));

    assert.equal(stopCalls.length, 0);
    assert.equal(emitted.length, 0);
  });
});
