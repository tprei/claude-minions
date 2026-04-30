import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { PermissionTier } from "@minions/shared";
import { buildSpawnArgs, buildResumeArgs } from "./claudeCode.js";

const DANGEROUS = "--dangerously-skip-permissions";
const PLAN_MODE_FLAGS = ["--permission-mode", "plan"];
const ACCEPT_EDITS_FLAGS = ["--permission-mode", "acceptEdits"];

function hasSequentialFlags(args: string[], flags: string[]): boolean {
  for (let i = 0; i <= args.length - flags.length; i++) {
    if (flags.every((f, j) => args[i + j] === f)) return true;
  }
  return false;
}

function indexOfPair(args: string[], a: string, b: string): number {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === a && args[i + 1] === b) return i;
  }
  return -1;
}

const WORKTREE = "/tmp/wt";

const baseSpawn = {
  sessionSlug: "s1",
  worktree: WORKTREE,
  prompt: "hello",
  env: {},
};

const baseResume = {
  sessionSlug: "s1",
  worktree: WORKTREE,
  env: {},
};

describe("claudeCode argv :: permissionTier", () => {
  describe("spawn args", () => {
    test("tier=read uses --permission-mode plan and no skip-permissions, no add-dir", () => {
      const args = buildSpawnArgs({ ...baseSpawn, permissionTier: "read" });
      assert.ok(!args.includes(DANGEROUS), "read tier must not use --dangerously-skip-permissions");
      assert.ok(hasSequentialFlags(args, PLAN_MODE_FLAGS), "read tier must use --permission-mode plan");
      assert.ok(!args.includes("--add-dir"), "read tier must not use --add-dir");
    });

    test("tier=worktree uses --permission-mode acceptEdits and --add-dir <worktree>", () => {
      const args = buildSpawnArgs({ ...baseSpawn, permissionTier: "worktree" });
      assert.ok(!args.includes(DANGEROUS), "worktree tier must not use --dangerously-skip-permissions");
      assert.ok(hasSequentialFlags(args, ACCEPT_EDITS_FLAGS), "worktree tier must use --permission-mode acceptEdits");
      assert.ok(indexOfPair(args, "--add-dir", WORKTREE) >= 0, "worktree tier must pass --add-dir <worktree>");
    });

    test("tier=worktree without git-dir opts emits only --add-dir <worktree>", () => {
      const args = buildSpawnArgs({ ...baseSpawn, permissionTier: "worktree" });
      const addDirCount = args.filter((a) => a === "--add-dir").length;
      assert.equal(addDirCount, 1, "exactly one --add-dir entry expected");
      assert.ok(!args.includes("undefined"), "must not emit literal 'undefined' for missing git paths");
    });

    test("tier=worktree forwards --add-dir for worktreeGitDir and worktreeGitCommonDir", () => {
      const args = buildSpawnArgs({
        ...baseSpawn,
        permissionTier: "worktree",
        worktreeGitDir: "/fake/git/dir",
        worktreeGitCommonDir: "/fake/common",
      });
      assert.ok(indexOfPair(args, "--add-dir", WORKTREE) >= 0, "worktree --add-dir must be present");
      assert.ok(indexOfPair(args, "--add-dir", "/fake/git/dir") >= 0, "gitDir must be passed via --add-dir");
      assert.ok(indexOfPair(args, "--add-dir", "/fake/common") >= 0, "gitCommonDir must be passed via --add-dir");
    });

    test("tier=read ignores worktreeGitDir/worktreeGitCommonDir", () => {
      const args = buildSpawnArgs({
        ...baseSpawn,
        permissionTier: "read",
        worktreeGitDir: "/fake/git/dir",
        worktreeGitCommonDir: "/fake/common",
      });
      assert.ok(!args.includes("--add-dir"), "read tier must not emit any --add-dir even when git paths provided");
    });

    test("tier=full ignores worktreeGitDir/worktreeGitCommonDir", () => {
      const args = buildSpawnArgs({
        ...baseSpawn,
        permissionTier: "full",
        worktreeGitDir: "/fake/git/dir",
        worktreeGitCommonDir: "/fake/common",
      });
      assert.ok(!args.includes("--add-dir"), "full tier must not emit any --add-dir even when git paths provided");
    });

    test("tier=full uses --dangerously-skip-permissions", () => {
      const args = buildSpawnArgs({ ...baseSpawn, permissionTier: "full" });
      assert.ok(args.includes(DANGEROUS), "full tier must use --dangerously-skip-permissions");
      assert.ok(!hasSequentialFlags(args, PLAN_MODE_FLAGS), "full tier must not use --permission-mode plan");
      assert.ok(!hasSequentialFlags(args, ACCEPT_EDITS_FLAGS), "full tier must not use --permission-mode acceptEdits");
    });

    test("permissionTier omitted behaves as full (back-compat)", () => {
      const args = buildSpawnArgs(baseSpawn);
      assert.ok(args.includes(DANGEROUS), "default must use --dangerously-skip-permissions");
    });

    test("preserves model, mcp, prompt regardless of tier", () => {
      const tiers: PermissionTier[] = ["read", "worktree", "full"];
      for (const tier of tiers) {
        const args = buildSpawnArgs({
          ...baseSpawn,
          prompt: "do thing",
          permissionTier: tier,
          modelHint: "claude-sonnet-4-6",
          mcpConfigPath: "/tmp/mcp.json",
        });
        assert.ok(args.includes("--model"), `tier=${tier}`);
        assert.ok(args.includes("claude-sonnet-4-6"), `tier=${tier}`);
        assert.ok(args.includes("--mcp-config"), `tier=${tier}`);
        assert.ok(args.includes("/tmp/mcp.json"), `tier=${tier}`);
        assert.equal(args[args.length - 2], "--", `tier=${tier}`);
        assert.equal(args[args.length - 1], "do thing", `tier=${tier}`);
      }
    });
  });

  describe("resume args", () => {
    test("tier=read uses --permission-mode plan and no skip-permissions, no add-dir", () => {
      const args = buildResumeArgs({ ...baseResume, permissionTier: "read" });
      assert.ok(!args.includes(DANGEROUS));
      assert.ok(hasSequentialFlags(args, PLAN_MODE_FLAGS));
      assert.ok(!args.includes("--add-dir"));
    });

    test("tier=worktree uses --permission-mode acceptEdits and --add-dir <worktree>", () => {
      const args = buildResumeArgs({ ...baseResume, permissionTier: "worktree" });
      assert.ok(!args.includes(DANGEROUS));
      assert.ok(hasSequentialFlags(args, ACCEPT_EDITS_FLAGS));
      assert.ok(indexOfPair(args, "--add-dir", WORKTREE) >= 0);
    });

    test("tier=worktree without git-dir opts emits only --add-dir <worktree>", () => {
      const args = buildResumeArgs({ ...baseResume, permissionTier: "worktree" });
      const addDirCount = args.filter((a) => a === "--add-dir").length;
      assert.equal(addDirCount, 1, "exactly one --add-dir entry expected");
      assert.ok(!args.includes("undefined"), "must not emit literal 'undefined' for missing git paths");
    });

    test("tier=worktree forwards --add-dir for worktreeGitDir and worktreeGitCommonDir", () => {
      const args = buildResumeArgs({
        ...baseResume,
        permissionTier: "worktree",
        worktreeGitDir: "/fake/git/dir",
        worktreeGitCommonDir: "/fake/common",
      });
      assert.ok(indexOfPair(args, "--add-dir", WORKTREE) >= 0);
      assert.ok(indexOfPair(args, "--add-dir", "/fake/git/dir") >= 0);
      assert.ok(indexOfPair(args, "--add-dir", "/fake/common") >= 0);
    });

    test("tier=read ignores worktreeGitDir/worktreeGitCommonDir", () => {
      const args = buildResumeArgs({
        ...baseResume,
        permissionTier: "read",
        worktreeGitDir: "/fake/git/dir",
        worktreeGitCommonDir: "/fake/common",
      });
      assert.ok(!args.includes("--add-dir"));
    });

    test("tier=full ignores worktreeGitDir/worktreeGitCommonDir", () => {
      const args = buildResumeArgs({
        ...baseResume,
        permissionTier: "full",
        worktreeGitDir: "/fake/git/dir",
        worktreeGitCommonDir: "/fake/common",
      });
      assert.ok(!args.includes("--add-dir"));
    });

    test("tier=full uses --dangerously-skip-permissions", () => {
      const args = buildResumeArgs({ ...baseResume, permissionTier: "full" });
      assert.ok(args.includes(DANGEROUS));
    });

    test("permissionTier omitted behaves as full (back-compat)", () => {
      const args = buildResumeArgs(baseResume);
      assert.ok(args.includes(DANGEROUS));
    });

    test("preserves --resume id and --mcp-config regardless of tier", () => {
      const tiers: PermissionTier[] = ["read", "worktree", "full"];
      for (const tier of tiers) {
        const args = buildResumeArgs({
          ...baseResume,
          permissionTier: tier,
          externalId: "ext-123",
          mcpConfigPath: "/tmp/mcp.json",
        });
        assert.ok(args.includes("--resume"), `tier=${tier}`);
        assert.ok(args.includes("ext-123"), `tier=${tier}`);
        assert.ok(args.includes("--mcp-config"), `tier=${tier}`);
        assert.ok(args.includes("/tmp/mcp.json"), `tier=${tier}`);
      }
    });
  });
});
