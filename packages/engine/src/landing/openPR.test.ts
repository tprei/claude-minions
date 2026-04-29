import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewDecision } from "./openPR.js";

describe("normalizeReviewDecision", () => {
  test("maps gh uppercase decisions to lowercase enum values", () => {
    assert.equal(normalizeReviewDecision("APPROVED"), "approved");
    assert.equal(normalizeReviewDecision("CHANGES_REQUESTED"), "changes_requested");
    assert.equal(normalizeReviewDecision("COMMENTED"), "commented");
    assert.equal(normalizeReviewDecision("REVIEW_REQUIRED"), "review_required");
  });

  test("passes through already-lowercase values", () => {
    assert.equal(normalizeReviewDecision("approved"), "approved");
    assert.equal(normalizeReviewDecision("changes_requested"), "changes_requested");
  });

  test("returns null for missing or empty decision", () => {
    assert.equal(normalizeReviewDecision(null), null);
    assert.equal(normalizeReviewDecision(undefined), null);
    assert.equal(normalizeReviewDecision(""), null);
    assert.equal(normalizeReviewDecision("   "), null);
  });

  test("returns null for unknown strings rather than passing them through", () => {
    assert.equal(normalizeReviewDecision("dismissed"), null);
    assert.equal(normalizeReviewDecision("PENDING"), null);
  });

  test("returns null for non-string values", () => {
    assert.equal(normalizeReviewDecision(42), null);
    assert.equal(normalizeReviewDecision({}), null);
    assert.equal(normalizeReviewDecision(true), null);
  });
});
