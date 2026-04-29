import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rollupToChecks } from "./index.js";

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
