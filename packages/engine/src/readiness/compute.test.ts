import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Session, AttentionFlag, PRSummary } from "@minions/shared";
import { computeCiCheck, computeReviewCheck } from "./compute.js";

function makeSession(pr: PRSummary | undefined, attention: AttentionFlag[] = []): Session {
  const now = new Date().toISOString();
  return {
    slug: "s",
    title: "s",
    prompt: "p",
    mode: "task",
    status: "running",
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

const openPr: PRSummary = {
  number: 1,
  url: "https://example.test/pr/1",
  state: "open",
  draft: false,
  base: "main",
  head: "feature-1",
  title: "PR",
};

function flag(kind: AttentionFlag["kind"], message = "msg"): AttentionFlag {
  return { kind, message, raisedAt: new Date().toISOString() };
}

describe("computeCiCheck", () => {
  test("returns pending when session has no PR", () => {
    const r = computeCiCheck(makeSession(undefined));
    assert.equal(r.status, "pending");
  });

  test("returns blocked when ci_failed is in attention", () => {
    const r = computeCiCheck(makeSession(openPr, [flag("ci_failed", "boom")]));
    assert.equal(r.status, "blocked");
    assert.equal(r.detail, "CI checks failed");
  });

  test("returns ok only when ci_passed is in attention", () => {
    const r = computeCiCheck(makeSession(openPr, [flag("ci_passed", "green")]));
    assert.equal(r.status, "ok");
  });

  test("returns pending (not ok) when PR exists but no CI signal yet", () => {
    const r = computeCiCheck(makeSession(openPr, []));
    assert.equal(r.status, "pending");
    assert.equal(r.detail, "CI checks in progress");
  });

  test("returns pending when ci_pending is in attention without ci_passed", () => {
    const r = computeCiCheck(makeSession(openPr, [flag("ci_pending", "queued")]));
    assert.equal(r.status, "pending");
  });

  test("ci_failed wins over ci_passed when both somehow present", () => {
    const r = computeCiCheck(makeSession(openPr, [flag("ci_passed"), flag("ci_failed", "fail")]));
    assert.equal(r.status, "blocked");
  });

  test("unrelated attention flags do not green-light CI", () => {
    const r = computeCiCheck(makeSession(openPr, [flag("needs_input"), flag("rebase_conflict")]));
    assert.equal(r.status, "pending");
  });
});

describe("computeReviewCheck", () => {
  test("returns pending when session has no PR", () => {
    const r = computeReviewCheck(makeSession(undefined));
    assert.equal(r.status, "pending");
  });

  test("returns ok when reviewDecision is approved", () => {
    const pr: PRSummary = { ...openPr, reviewDecision: "approved" };
    const r = computeReviewCheck(makeSession(pr));
    assert.equal(r.status, "ok");
    assert.equal(r.label, "Review approved");
  });

  test("returns blocked when changes_requested", () => {
    const pr: PRSummary = { ...openPr, reviewDecision: "changes_requested" };
    const r = computeReviewCheck(makeSession(pr));
    assert.equal(r.status, "blocked");
    assert.equal(r.detail, "Changes requested");
  });

  test("returns pending when review is awaited (review_required, commented, missing, null)", () => {
    for (const rd of ["review_required", "commented", undefined, null] as const) {
      const pr: PRSummary = { ...openPr, reviewDecision: rd };
      const r = computeReviewCheck(makeSession(pr));
      assert.equal(r.status, "pending", `expected pending for reviewDecision=${String(rd)}`);
    }
  });
});
