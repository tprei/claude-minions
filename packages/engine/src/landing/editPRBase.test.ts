import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { editPullRequestBase } from "./editPRBase.js";
import { createLogger } from "../logger.js";
import type { EngineContext } from "../context.js";
import type { GithubSubsystem } from "../github/index.js";

function makeCtx(editPRBaseMock: (repoId: string, prNumber: number, newBase: string) => Promise<void>): EngineContext {
  const github: Partial<GithubSubsystem> = {
    editPRBase: editPRBaseMock,
  };
  return {
    github: github as GithubSubsystem,
  } as unknown as EngineContext;
}

describe("editPullRequestBase", () => {
  test("delegates to ctx.github.editPRBase with the correct args", async () => {
    const calls: Array<{ repoId: string; prNumber: number; newBase: string }> = [];
    const ctx = makeCtx(async (repoId, prNumber, newBase) => {
      calls.push({ repoId, prNumber, newBase });
    });

    await editPullRequestBase({
      ctx,
      repoId: "repo-1",
      prNumber: 99,
      newBase: "main",
      log: createLogger("error"),
    });

    assert.equal(calls.length, 1, "editPRBase invoked once");
    assert.deepEqual(calls[0], { repoId: "repo-1", prNumber: 99, newBase: "main" });
  });

  test("propagates errors from ctx.github.editPRBase", async () => {
    const ctx = makeCtx(async () => {
      throw new Error("boom from api");
    });

    await assert.rejects(
      () =>
        editPullRequestBase({
          ctx,
          repoId: "repo-1",
          prNumber: 5,
          newBase: "main",
          log: createLogger("error"),
        }),
      /boom from api/,
    );
  });
});
