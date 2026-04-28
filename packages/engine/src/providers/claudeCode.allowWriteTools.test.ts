import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs, buildResumeArgs } from "./claudeCode.js";

const DANGEROUS = "--dangerously-skip-permissions";

const baseSpawn = {
  sessionSlug: "s1",
  worktree: "/tmp/x",
  prompt: "hello",
  env: {},
};

const baseResume = {
  sessionSlug: "s1",
  worktree: "/tmp/x",
  env: {},
};

describe("claudeCode argv :: allowWriteTools", () => {
  describe("spawn args", () => {
    test("default (allowWriteTools omitted) keeps --dangerously-skip-permissions", () => {
      const args = buildSpawnArgs(baseSpawn);
      assert.ok(args.includes(DANGEROUS), "expected dangerous flag for default");
    });

    test("allowWriteTools=true keeps --dangerously-skip-permissions", () => {
      const args = buildSpawnArgs({ ...baseSpawn, allowWriteTools: true });
      assert.ok(args.includes(DANGEROUS), "expected dangerous flag when allowWriteTools=true");
    });

    test("allowWriteTools=false drops --dangerously-skip-permissions", () => {
      const args = buildSpawnArgs({ ...baseSpawn, allowWriteTools: false });
      assert.ok(!args.includes(DANGEROUS), "expected no dangerous flag when allowWriteTools=false");
    });

    test("preserves model, mcp, prompt regardless of allowWriteTools", () => {
      const args = buildSpawnArgs({
        ...baseSpawn,
        prompt: "do thing",
        allowWriteTools: false,
        modelHint: "claude-sonnet-4-6",
        mcpConfigPath: "/tmp/mcp.json",
      });
      assert.ok(args.includes("--model"));
      assert.ok(args.includes("claude-sonnet-4-6"));
      assert.ok(args.includes("--mcp-config"));
      assert.ok(args.includes("/tmp/mcp.json"));
      assert.equal(args[args.length - 2], "--");
      assert.equal(args[args.length - 1], "do thing");
    });
  });

  describe("resume args", () => {
    test("default (allowWriteTools omitted) keeps --dangerously-skip-permissions", () => {
      const args = buildResumeArgs(baseResume);
      assert.ok(args.includes(DANGEROUS), "expected dangerous flag for default");
    });

    test("allowWriteTools=true keeps --dangerously-skip-permissions", () => {
      const args = buildResumeArgs({ ...baseResume, allowWriteTools: true });
      assert.ok(args.includes(DANGEROUS), "expected dangerous flag when allowWriteTools=true");
    });

    test("allowWriteTools=false drops --dangerously-skip-permissions", () => {
      const args = buildResumeArgs({ ...baseResume, allowWriteTools: false });
      assert.ok(!args.includes(DANGEROUS), "expected no dangerous flag when allowWriteTools=false");
    });

    test("preserves --resume id and --mcp-config regardless of allowWriteTools", () => {
      const args = buildResumeArgs({
        ...baseResume,
        allowWriteTools: false,
        externalId: "ext-123",
        mcpConfigPath: "/tmp/mcp.json",
      });
      assert.ok(args.includes("--resume"));
      assert.ok(args.includes("ext-123"));
      assert.ok(args.includes("--mcp-config"));
      assert.ok(args.includes("/tmp/mcp.json"));
    });
  });
});
