import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EngineError, isEngineError } from "../errors.js";
import {
  __setBuildSpawnHandleForTests,
  __setFindClaudeBinaryForTests,
  claudeCodeProvider,
} from "./claudeCode.js";

describe("claudeCodeProvider.spawn — claude binary missing", () => {
  it("rejects with EngineError(upstream) and never invokes child_process spawn", async () => {
    __setFindClaudeBinaryForTests(async () => null);
    let buildCalls = 0;
    __setBuildSpawnHandleForTests(() => {
      buildCalls++;
      throw new Error("buildSpawnHandle should not be reached");
    });
    try {
      await assert.rejects(
        claudeCodeProvider.spawn({
          sessionSlug: "test-session",
          worktree: "/tmp/test-worktree",
          prompt: "do something",
          env: {},
        }),
        (err: unknown) => {
          assert.ok(isEngineError(err), "must throw EngineError");
          const e = err as EngineError;
          assert.equal(e.code, "upstream");
          assert.equal(e.status, 502);
          assert.match(e.message, /claude CLI not found/i);
          assert.equal(e.detail?.["provider"], "claude-code");
          assert.equal(e.detail?.["op"], "spawn");
          assert.equal(e.detail?.["sessionSlug"], "test-session");
          return true;
        },
      );
      assert.equal(buildCalls, 0, "no child process must be spawned");
    } finally {
      __setFindClaudeBinaryForTests(null);
      __setBuildSpawnHandleForTests(null);
    }
  });
});

describe("claudeCodeProvider.resume — claude binary missing", () => {
  it("rejects with EngineError(upstream) and never invokes child_process spawn", async () => {
    __setFindClaudeBinaryForTests(async () => null);
    let buildCalls = 0;
    __setBuildSpawnHandleForTests(() => {
      buildCalls++;
      throw new Error("buildSpawnHandle should not be reached");
    });
    try {
      await assert.rejects(
        claudeCodeProvider.resume({
          sessionSlug: "test-session",
          worktree: "/tmp/test-worktree",
          externalId: "ext-abc",
          env: {},
        }),
        (err: unknown) => {
          assert.ok(isEngineError(err), "must throw EngineError");
          const e = err as EngineError;
          assert.equal(e.code, "upstream");
          assert.match(e.message, /claude CLI not found/i);
          assert.equal(e.detail?.["provider"], "claude-code");
          assert.equal(e.detail?.["op"], "resume");
          assert.equal(e.detail?.["sessionSlug"], "test-session");
          return true;
        },
      );
      assert.equal(buildCalls, 0, "no child process must be spawned");
    } finally {
      __setFindClaudeBinaryForTests(null);
      __setBuildSpawnHandleForTests(null);
    }
  });
});

describe("claudeCodeProvider — does not silently fall back to mock", () => {
  it("error.detail.provider is claude-code (not mock) when binary missing", async () => {
    __setFindClaudeBinaryForTests(async () => null);
    try {
      const err = await claudeCodeProvider
        .spawn({ sessionSlug: "s1", worktree: "/tmp/w", prompt: "p", env: {} })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(isEngineError(err));
      assert.equal((err as EngineError).detail?.["provider"], "claude-code");
      assert.notEqual((err as EngineError).detail?.["provider"], "mock");
    } finally {
      __setFindClaudeBinaryForTests(null);
    }
  });
});
