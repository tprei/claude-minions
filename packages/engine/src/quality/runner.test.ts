import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runChecks } from "./runner.js";

describe("runChecks", () => {
  it("returns passed with empty checks when no configs (no gates means no failures)", async () => {
    const result = await runChecks([], tmpdir());
    assert.equal(result.status, "passed");
    assert.deepEqual(result.checks, []);
  });

  it("runs a passing check and returns passed status", async () => {
    const result = await runChecks(
      [{ name: "echo-check", command: "echo ok" }],
      tmpdir(),
    );
    assert.equal(result.status, "passed");
    assert.equal(result.checks.length, 1);
    const check = result.checks[0];
    assert.ok(check);
    assert.equal(check.status, "passed");
    assert.equal(check.exitCode, 0);
    assert.equal(check.name, "echo-check");
  });

  it("runs a failing check and returns failed status", async () => {
    const result = await runChecks(
      [{ name: "fail-check", command: "exit 1", required: true }],
      tmpdir(),
    );
    assert.equal(result.status, "failed");
    const check = result.checks[0];
    assert.ok(check);
    assert.equal(check.status, "failed");
    assert.notEqual(check.exitCode, 0);
  });

  it("returns partial when only non-required check fails", async () => {
    const result = await runChecks(
      [
        { name: "pass-check", command: "echo ok", required: true },
        { name: "fail-optional", command: "exit 1", required: false },
      ],
      tmpdir(),
    );
    assert.equal(result.status, "partial");
  });

  it("includes stdout in the report", async () => {
    const result = await runChecks(
      [{ name: "output-check", command: "echo hello-world" }],
      tmpdir(),
    );
    const check = result.checks[0];
    assert.ok(check);
    assert.ok(check.stdoutTail?.includes("hello-world"));
  });
});
