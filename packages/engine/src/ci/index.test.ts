import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AttentionFlag } from "@minions/shared";
import {
  applyCiPassedAttention,
  computeCiAttentionUpdate,
  rollupToChecks,
  summarizeChecks,
  bucketChecks,
  decideSelfHeal,
  decideAutoMerge,
  readAttempts,
  buildSelfHealPrompt,
} from "./index.js";

describe("rollupToChecks", () => {
  test("returns empty array for null/undefined rollup", () => {
    assert.deepEqual(rollupToChecks(null), []);
    assert.deepEqual(rollupToChecks(undefined), []);
    assert.deepEqual(rollupToChecks([]), []);
  });

  test("maps a passing CheckRun to bucket=pass", () => {
    const checks = rollupToChecks([
      {
        __typename: "CheckRun",
        name: "build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "ci",
        detailsUrl: "https://gh.test/run/1",
      },
    ]);
    assert.deepEqual(checks, [
      {
        name: "build",
        state: "SUCCESS",
        bucket: "pass",
        workflow: "ci",
        link: "https://gh.test/run/1",
      },
    ]);
  });

  test("maps a failing CheckRun to bucket=fail across fail conclusions", () => {
    const conclusions = ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"];
    for (const conclusion of conclusions) {
      const checks = rollupToChecks([
        {
          __typename: "CheckRun",
          name: "test",
          status: "COMPLETED",
          conclusion,
          workflowName: "ci",
          detailsUrl: "https://gh.test/run/2",
        },
      ]);
      assert.equal(checks[0]?.bucket, "fail", `expected fail for conclusion=${conclusion}`);
      assert.equal(checks[0]?.name, "test");
      assert.equal(checks[0]?.workflow, "ci");
      assert.equal(checks[0]?.link, "https://gh.test/run/2");
    }
  });

  test("maps an in-progress CheckRun (empty conclusion) to bucket=pending", () => {
    const checks = rollupToChecks([
      {
        __typename: "CheckRun",
        name: "lint",
        status: "IN_PROGRESS",
        conclusion: "",
        workflowName: "ci",
        detailsUrl: "https://gh.test/run/3",
      },
    ]);
    assert.equal(checks[0]?.bucket, "pending");
    assert.equal(checks[0]?.state, "IN_PROGRESS");
  });

  test("maps a successful StatusContext to bucket=pass", () => {
    const checks = rollupToChecks([
      {
        __typename: "StatusContext",
        context: "ci/circleci",
        state: "SUCCESS",
        targetUrl: "https://circleci.test/job/1",
      },
    ]);
    assert.deepEqual(checks, [
      {
        name: "ci/circleci",
        state: "SUCCESS",
        bucket: "pass",
        workflow: "",
        link: "https://circleci.test/job/1",
      },
    ]);
  });

  test("maps StatusContext FAILURE and ERROR states to bucket=fail", () => {
    for (const state of ["FAILURE", "ERROR"]) {
      const checks = rollupToChecks([
        {
          __typename: "StatusContext",
          context: "ci/legacy",
          state,
          targetUrl: "https://legacy.test/x",
        },
      ]);
      assert.equal(checks[0]?.bucket, "fail", `expected fail for state=${state}`);
      assert.equal(checks[0]?.workflow, "");
    }
  });

  test("maps a pending StatusContext to bucket=pending", () => {
    const checks = rollupToChecks([
      {
        __typename: "StatusContext",
        context: "ci/legacy",
        state: "PENDING",
        targetUrl: "https://legacy.test/y",
      },
    ]);
    assert.equal(checks[0]?.bucket, "pending");
  });

  test("handles a mixed rollup of CheckRun and StatusContext entries", () => {
    const checks = rollupToChecks([
      {
        __typename: "CheckRun",
        name: "unit",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "ci",
        detailsUrl: "https://gh.test/a",
      },
      {
        __typename: "CheckRun",
        name: "e2e",
        status: "COMPLETED",
        conclusion: "FAILURE",
        workflowName: "ci",
        detailsUrl: "https://gh.test/b",
      },
      {
        __typename: "StatusContext",
        context: "ci/legacy",
        state: "PENDING",
        targetUrl: "https://legacy.test/c",
      },
    ]);
    assert.equal(checks.length, 3);
    assert.equal(checks[0]?.bucket, "pass");
    assert.equal(checks[1]?.bucket, "fail");
    assert.equal(checks[2]?.bucket, "pending");
  });

  test("falls back to property-based discrimination when __typename is absent", () => {
    const checks = rollupToChecks([
      {
        name: "build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        workflowName: "ci",
        detailsUrl: "https://gh.test/run/4",
      },
      {
        context: "ci/legacy",
        state: "FAILURE",
        targetUrl: "https://legacy.test/z",
      },
    ]);
    assert.equal(checks[0]?.bucket, "pass");
    assert.equal(checks[0]?.name, "build");
    assert.equal(checks[1]?.bucket, "fail");
    assert.equal(checks[1]?.name, "ci/legacy");
  });
});

describe("summarizeChecks", () => {
  test("empty rollup is pending", () => {
    const s = summarizeChecks([]);
    assert.equal(s.state, "pending");
    assert.deepEqual(s.counts, { passed: 0, failed: 0, pending: 0 });
    assert.deepEqual(s.checks, []);
  });

  test("any failing check yields failing state", () => {
    const s = summarizeChecks([
      { name: "build", state: "SUCCESS", bucket: "pass", workflow: "ci", link: "" },
      { name: "test", state: "FAILURE", bucket: "fail", workflow: "ci", link: "" },
      { name: "lint", state: "IN_PROGRESS", bucket: "pending", workflow: "ci", link: "" },
    ]);
    assert.equal(s.state, "failing");
    assert.deepEqual(s.counts, { passed: 1, failed: 1, pending: 1 });
    assert.equal(s.checks.length, 3);
    assert.equal(s.checks[1]?.bucket, "fail");
  });

  test("only pending+pass yields pending", () => {
    const s = summarizeChecks([
      { name: "build", state: "SUCCESS", bucket: "pass", workflow: "ci", link: "" },
      { name: "lint", state: "QUEUED", bucket: "pending", workflow: "ci", link: "" },
    ]);
    assert.equal(s.state, "pending");
    assert.deepEqual(s.counts, { passed: 1, failed: 0, pending: 1 });
  });

  test("all-pass is passing", () => {
    const s = summarizeChecks([
      { name: "build", state: "SUCCESS", bucket: "pass", workflow: "ci", link: "" },
      { name: "test", state: "SUCCESS", bucket: "pass", workflow: "ci", link: "" },
    ]);
    assert.equal(s.state, "passing");
    assert.deepEqual(s.counts, { passed: 2, failed: 0, pending: 0 });
  });
});

describe("computeCiAttentionUpdate", () => {
  const RAISED = "2026-04-30T12:00:00.000Z";
  const PRIOR = "2026-04-30T11:00:00.000Z";

  function ciFailed(message: string, raisedAt = PRIOR): AttentionFlag {
    return { kind: "ci_failed", message, raisedAt };
  }

  test("noop when no failures and no existing ci_failed", () => {
    const result = computeCiAttentionUpdate([], [], RAISED);
    assert.deepEqual(result, { kind: "noop" });
  });

  test("noop when no failures and only unrelated attention flags", () => {
    const others: AttentionFlag[] = [
      { kind: "needs_input", message: "n", raisedAt: PRIOR },
    ];
    const result = computeCiAttentionUpdate(others, [], RAISED);
    assert.deepEqual(result, { kind: "noop" });
  });

  test("adds a ci_failed flag when a fresh failure appears", () => {
    const result = computeCiAttentionUpdate([], ["test", "lint"], RAISED);
    assert.equal(result.kind, "add");
    if (result.kind !== "add") return;
    assert.equal(result.attention.length, 1);
    assert.equal(result.attention[0]?.kind, "ci_failed");
    assert.equal(result.attention[0]?.message, "CI checks failed: test, lint");
    assert.equal(result.attention[0]?.raisedAt, RAISED);
  });

  test("preserves unrelated attention when adding ci_failed", () => {
    const others: AttentionFlag[] = [
      { kind: "needs_input", message: "n", raisedAt: PRIOR },
    ];
    const result = computeCiAttentionUpdate(others, ["test"], RAISED);
    assert.equal(result.kind, "add");
    if (result.kind !== "add") return;
    assert.equal(result.attention.length, 2);
    assert.equal(result.attention[0]?.kind, "needs_input");
    assert.equal(result.attention[1]?.kind, "ci_failed");
  });

  test("updates existing ci_failed in place rather than appending a duplicate", () => {
    const current: AttentionFlag[] = [ciFailed("CI checks failed: old")];
    const result = computeCiAttentionUpdate(current, ["test"], RAISED);
    assert.equal(result.kind, "update");
    if (result.kind !== "update") return;
    assert.equal(result.attention.length, 1);
    assert.equal(result.attention[0]?.kind, "ci_failed");
    assert.equal(result.attention[0]?.message, "CI checks failed: test");
    assert.equal(result.attention[0]?.raisedAt, RAISED);
    assert.equal(result.previousMessage, "CI checks failed: old");
  });

  test("does not add a duplicate when the same failure is detected twice", () => {
    const current: AttentionFlag[] = [ciFailed("CI checks failed: test")];
    const result = computeCiAttentionUpdate(current, ["test"], RAISED);
    assert.equal(result.kind, "update");
    if (result.kind !== "update") return;
    const ciFailedCount = result.attention.filter((a) => a.kind === "ci_failed").length;
    assert.equal(ciFailedCount, 1);
  });

  test("clears stale ci_failed when checks come back all-passing", () => {
    const current: AttentionFlag[] = [ciFailed("CI checks failed: test")];
    const result = computeCiAttentionUpdate(current, [], RAISED);
    assert.equal(result.kind, "clear");
    if (result.kind !== "clear") return;
    assert.equal(result.attention.length, 0);
    assert.equal(result.previousMessage, "CI checks failed: test");
  });

  test("clear preserves unrelated attention flags", () => {
    const current: AttentionFlag[] = [
      { kind: "needs_input", message: "n", raisedAt: PRIOR },
      ciFailed("CI checks failed: test"),
      { kind: "rebase_conflict", message: "r", raisedAt: PRIOR },
    ];
    const result = computeCiAttentionUpdate(current, [], RAISED);
    assert.equal(result.kind, "clear");
    if (result.kind !== "clear") return;
    assert.equal(result.attention.length, 2);
    assert.deepEqual(
      result.attention.map((a) => a.kind),
      ["needs_input", "rebase_conflict"],
    );
  });
});

describe("applyCiPassedAttention", () => {
  const RAISED = "2026-04-30T12:00:00.000Z";
  const PRIOR = "2026-04-30T11:00:00.000Z";

  test("terminal SUCCESS adds ci_passed and clears ci_pending and ci_failed", () => {
    const current: AttentionFlag[] = [
      { kind: "ci_pending", message: "running", raisedAt: PRIOR },
      { kind: "ci_failed", message: "stale", raisedAt: PRIOR },
      { kind: "needs_input", message: "n", raisedAt: PRIOR },
    ];
    const next = applyCiPassedAttention(current, RAISED);
    assert.ok(next, "expected an updated attention array");
    assert.equal(next.length, 2);
    assert.deepEqual(
      next.map((a) => a.kind),
      ["needs_input", "ci_passed"],
    );
    const passed = next.find((a) => a.kind === "ci_passed");
    assert.equal(passed?.message, "All checks passed");
    assert.equal(passed?.raisedAt, RAISED);
  });

  test("idempotent when ci_passed is already present and no stale flags exist", () => {
    const current: AttentionFlag[] = [
      { kind: "ci_passed", message: "All checks passed", raisedAt: PRIOR },
      { kind: "needs_input", message: "n", raisedAt: PRIOR },
    ];
    assert.equal(applyCiPassedAttention(current, RAISED), null);
  });

  test("strips stale ci_pending/ci_failed even when ci_passed is already present", () => {
    const current: AttentionFlag[] = [
      { kind: "ci_pending", message: "p", raisedAt: PRIOR },
      { kind: "ci_passed", message: "All checks passed", raisedAt: PRIOR },
    ];
    const next = applyCiPassedAttention(current, RAISED);
    assert.ok(next);
    assert.equal(next.length, 1);
    assert.equal(next[0]?.kind, "ci_passed");
    assert.equal(next[0]?.raisedAt, PRIOR, "preserves the original raisedAt when ci_passed already exists");
  });
});

describe("bucketChecks", () => {
  test("partitions checks by bucket and projects names", () => {
    const buckets = bucketChecks([
      { name: "build", state: "SUCCESS", bucket: "pass", workflow: "ci", link: "" },
      { name: "test", state: "FAILURE", bucket: "fail", workflow: "ci", link: "" },
      { name: "lint", state: "IN_PROGRESS", bucket: "pending", workflow: "ci", link: "" },
      { name: "e2e", state: "FAILURE", bucket: "fail", workflow: "ci", link: "" },
    ]);
    assert.deepEqual(buckets.passed, ["build"]);
    assert.deepEqual(buckets.failed, ["test", "e2e"]);
    assert.deepEqual(buckets.pending, ["lint"]);
  });

  test("returns empty arrays for an empty input", () => {
    const buckets = bucketChecks([]);
    assert.deepEqual(buckets, { failed: [], pending: [], passed: [] });
  });
});

describe("decideSelfHeal", () => {
  const empty = { failed: [], pending: [], passed: [] };

  test("returns noop with reason self-heal-disabled when disabled", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: false,
      attempts: 0,
      maxAttempts: 3,
      buckets: { failed: ["test"], pending: [], passed: [] },
    });
    assert.deepEqual(decision, { kind: "noop", reason: "self-heal-disabled" });
  });

  test("returns noop with reason no-checks-yet when checks list is empty", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: true,
      attempts: 0,
      maxAttempts: 3,
      buckets: empty,
    });
    assert.deepEqual(decision, { kind: "noop", reason: "no-checks-yet" });
  });

  test("returns noop with reason still-pending if any pending check exists", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: true,
      attempts: 0,
      maxAttempts: 3,
      buckets: { failed: ["test"], pending: ["lint"], passed: ["build"] },
    });
    assert.deepEqual(decision, { kind: "noop", reason: "still-pending" });
  });

  test("returns success when terminal and all checks passed", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: true,
      attempts: 1,
      maxAttempts: 3,
      buckets: { failed: [], pending: [], passed: ["build", "test"] },
    });
    assert.deepEqual(decision, { kind: "success" });
  });

  test("returns retry with incremented attempts when terminal failure under cap", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: true,
      attempts: 0,
      maxAttempts: 3,
      buckets: { failed: ["test", "lint"], pending: [], passed: ["build"] },
    });
    assert.deepEqual(decision, { kind: "retry", nextAttempts: 1, failedNames: ["test", "lint"] });
  });

  test("returns retry up to the last allowed attempt", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: true,
      attempts: 2,
      maxAttempts: 3,
      buckets: { failed: ["test"], pending: [], passed: [] },
    });
    assert.deepEqual(decision, { kind: "retry", nextAttempts: 3, failedNames: ["test"] });
  });

  test("returns exhausted when attempts have hit the cap", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: true,
      attempts: 3,
      maxAttempts: 3,
      buckets: { failed: ["test"], pending: [], passed: [] },
    });
    assert.deepEqual(decision, {
      kind: "exhausted",
      failedNames: ["test"],
      attempts: 3,
    });
  });

  test("with maxAttempts=0, every terminal failure is exhausted with no retry", () => {
    const decision = decideSelfHeal({
      selfHealEnabled: true,
      attempts: 0,
      maxAttempts: 0,
      buckets: { failed: ["test"], pending: [], passed: [] },
    });
    assert.equal(decision.kind, "exhausted");
  });
});

describe("decideAutoMerge", () => {
  const greenInput = {
    flagEnabled: true,
    prState: "open" as const,
    prDraft: false,
    ciState: "passing" as const,
    failedCount: 0,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    sessionKind: "code" as string | undefined,
    sessionMode: "default" as string | undefined,
  };

  test("returns skip:flag-disabled when flag is off", () => {
    const decision = decideAutoMerge({ ...greenInput, flagEnabled: false });
    assert.deepEqual(decision, { kind: "skip", reason: "flag-disabled" });
  });

  test("returns skip:ineligible-session for fix-ci sessions", () => {
    const decision = decideAutoMerge({ ...greenInput, sessionKind: "fix-ci" });
    assert.deepEqual(decision, { kind: "skip", reason: "ineligible-session" });
  });

  test("returns skip:ineligible-session for rebase-resolver mode", () => {
    const decision = decideAutoMerge({ ...greenInput, sessionMode: "rebase-resolver" });
    assert.deepEqual(decision, { kind: "skip", reason: "ineligible-session" });
  });

  test("returns skip:pr-draft when PR is a draft", () => {
    const decision = decideAutoMerge({ ...greenInput, prDraft: true });
    assert.deepEqual(decision, { kind: "skip", reason: "pr-draft" });
  });

  test("returns skip:pr-not-open when PR is merged", () => {
    const decision = decideAutoMerge({ ...greenInput, prState: "merged" });
    assert.deepEqual(decision, { kind: "skip", reason: "pr-not-open" });
  });

  test("returns skip:ci-not-clean when CI is failing", () => {
    const failing = decideAutoMerge({ ...greenInput, ciState: "failing" });
    assert.deepEqual(failing, { kind: "skip", reason: "ci-not-clean" });
    const withFailedCount = decideAutoMerge({ ...greenInput, failedCount: 1 });
    assert.deepEqual(withFailedCount, { kind: "skip", reason: "ci-not-clean" });
  });

  test("returns skip:review-blocking when reviewers requested changes", () => {
    const decision = decideAutoMerge({ ...greenInput, reviewDecision: "CHANGES_REQUESTED" });
    assert.deepEqual(decision, { kind: "skip", reason: "review-blocking" });
  });

  test("returns skip:ci-not-clean when mergeStateStatus is BLOCKED", () => {
    const decision = decideAutoMerge({ ...greenInput, mergeStateStatus: "BLOCKED" });
    assert.deepEqual(decision, { kind: "skip", reason: "ci-not-clean" });
  });

  test("returns skip:not-mergeable when mergeable is CONFLICTING", () => {
    const decision = decideAutoMerge({ ...greenInput, mergeable: "CONFLICTING" });
    assert.deepEqual(decision, { kind: "skip", reason: "not-mergeable" });
  });

  test("returns merge when fully green", () => {
    const decision = decideAutoMerge(greenInput);
    assert.deepEqual(decision, { kind: "merge" });
  });
});

describe("readAttempts", () => {
  test("returns 0 when missing", () => {
    assert.equal(readAttempts({}), 0);
  });
  test("returns 0 for non-numeric values", () => {
    assert.equal(readAttempts({ ciSelfHealAttempts: "2" }), 0);
    assert.equal(readAttempts({ ciSelfHealAttempts: null }), 0);
    assert.equal(readAttempts({ ciSelfHealAttempts: NaN }), 0);
  });
  test("clamps negative to 0", () => {
    assert.equal(readAttempts({ ciSelfHealAttempts: -3 }), 0);
  });
  test("floors fractional values", () => {
    assert.equal(readAttempts({ ciSelfHealAttempts: 2.7 }), 2);
  });
  test("returns the integer attempt count", () => {
    assert.equal(readAttempts({ ciSelfHealAttempts: 3 }), 3);
  });
});

describe("buildSelfHealPrompt", () => {
  test("includes PR number, failed checks, and log tail", () => {
    const prompt = buildSelfHealPrompt({
      prNumber: 42,
      failedNames: ["test", "lint"],
      logs: "tail line 1\ntail line 2",
    });
    assert.ok(prompt.includes("PR #42"));
    assert.ok(prompt.includes("test, lint"));
    assert.ok(prompt.includes("tail line 1\ntail line 2"));
    assert.ok(prompt.includes("do NOT open a new PR"));
  });

  test("omits the log tail block when logs are empty", () => {
    const prompt = buildSelfHealPrompt({ prNumber: 7, failedNames: ["e2e"], logs: "" });
    assert.ok(!prompt.includes("Log tail"));
    assert.ok(prompt.includes("PR #7"));
    assert.ok(prompt.includes("e2e"));
  });
});

describe("decideAutoMerge", () => {
  const greenInput = {
    flagEnabled: true,
    prState: "open" as const,
    prDraft: false,
    ciState: "passing" as const,
    failedCount: 0,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    sessionKind: "feature" as string | undefined,
    sessionMode: "default" as string | undefined,
  };

  test("returns skip:flag-disabled when the flag is off", () => {
    const decision = decideAutoMerge({ ...greenInput, flagEnabled: false });
    assert.deepEqual(decision, { kind: "skip", reason: "flag-disabled" });
  });

  test("returns skip:ineligible-session when sessionKind is fix-ci", () => {
    const decision = decideAutoMerge({ ...greenInput, sessionKind: "fix-ci" });
    assert.deepEqual(decision, { kind: "skip", reason: "ineligible-session" });
  });

  test("returns skip:ineligible-session when sessionMode is rebase-resolver", () => {
    const decision = decideAutoMerge({ ...greenInput, sessionMode: "rebase-resolver" });
    assert.deepEqual(decision, { kind: "skip", reason: "ineligible-session" });
  });

  test("returns skip:pr-draft when the PR is a draft", () => {
    const decision = decideAutoMerge({ ...greenInput, prDraft: true });
    assert.deepEqual(decision, { kind: "skip", reason: "pr-draft" });
  });

  test("returns skip:pr-not-open when the PR is merged", () => {
    const decision = decideAutoMerge({ ...greenInput, prState: "merged" });
    assert.deepEqual(decision, { kind: "skip", reason: "pr-not-open" });
  });

  test("returns skip:ci-not-clean when ciState is failing", () => {
    const decision = decideAutoMerge({ ...greenInput, ciState: "failing", failedCount: 1 });
    assert.deepEqual(decision, { kind: "skip", reason: "ci-not-clean" });
  });

  test("returns skip:ci-not-clean when failedCount > 0 even if state says passing", () => {
    const decision = decideAutoMerge({ ...greenInput, failedCount: 1 });
    assert.deepEqual(decision, { kind: "skip", reason: "ci-not-clean" });
  });

  test("returns skip:review-blocking when reviewDecision is CHANGES_REQUESTED", () => {
    const decision = decideAutoMerge({ ...greenInput, reviewDecision: "CHANGES_REQUESTED" });
    assert.deepEqual(decision, { kind: "skip", reason: "review-blocking" });
  });

  test("returns skip:ci-not-clean when mergeStateStatus is BLOCKED", () => {
    const decision = decideAutoMerge({ ...greenInput, mergeStateStatus: "BLOCKED" });
    assert.deepEqual(decision, { kind: "skip", reason: "ci-not-clean" });
  });

  test("returns skip:not-mergeable when mergeable is CONFLICTING", () => {
    const decision = decideAutoMerge({ ...greenInput, mergeable: "CONFLICTING" });
    assert.deepEqual(decision, { kind: "skip", reason: "not-mergeable" });
  });

  test("returns merge when fully green", () => {
    const decision = decideAutoMerge(greenInput);
    assert.deepEqual(decision, { kind: "merge" });
  });
});
