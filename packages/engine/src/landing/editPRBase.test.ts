import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEditPullRequestBase, type RunGhFn } from "./editPRBase.js";
import { createLogger } from "../logger.js";

describe("createEditPullRequestBase", () => {
  test("invokes gh api PATCH against repos/{owner}/{repo}/pulls/{n} with base body", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runGh: RunGhFn = async (args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      return "";
    };

    const editPullRequestBase = createEditPullRequestBase(runGh);
    await editPullRequestBase({
      cwd: "/tmp/worktrees/child",
      prNumber: 99,
      newBase: "main",
      remote: "https://github.com/acme/repo.git",
      log: createLogger("error"),
    });

    assert.equal(calls.length, 1, "runGh invoked once");
    assert.deepEqual(calls[0]?.args, [
      "api",
      "-X",
      "PATCH",
      "repos/acme/repo/pulls/99",
      "-f",
      "base=main",
    ]);
    assert.equal(calls[0]?.cwd, "/tmp/worktrees/child");
  });

  test("supports ssh remotes", async () => {
    const calls: string[][] = [];
    const runGh: RunGhFn = async (args) => {
      calls.push(args);
      return "";
    };

    const editPullRequestBase = createEditPullRequestBase(runGh);
    await editPullRequestBase({
      cwd: "/tmp",
      prNumber: 7,
      newBase: "develop",
      remote: "git@github.com:acme/repo.git",
      log: createLogger("error"),
    });

    assert.deepEqual(calls[0], [
      "api",
      "-X",
      "PATCH",
      "repos/acme/repo/pulls/7",
      "-f",
      "base=develop",
    ]);
  });

  test("throws on unparseable remote and does not invoke gh", async () => {
    let invoked = false;
    const runGh: RunGhFn = async () => {
      invoked = true;
      return "";
    };

    const editPullRequestBase = createEditPullRequestBase(runGh);
    await assert.rejects(
      () =>
        editPullRequestBase({
          cwd: "/tmp",
          prNumber: 1,
          newBase: "main",
          remote: "git@gitlab.com:acme/repo.git",
          log: createLogger("error"),
        }),
      /unable to parse owner\/repo/,
    );
    assert.equal(invoked, false, "gh must not be invoked for unparseable remote");
  });

  test("propagates non-zero gh failures with stderr", async () => {
    const runGh: RunGhFn = async (args) => {
      throw new Error(`gh ${args.join(" ")} exited 1: boom from stderr`);
    };

    const editPullRequestBase = createEditPullRequestBase(runGh);
    await assert.rejects(
      () =>
        editPullRequestBase({
          cwd: "/tmp",
          prNumber: 5,
          newBase: "main",
          remote: "https://github.com/acme/repo.git",
          log: createLogger("error"),
        }),
      /boom from stderr/,
    );
  });
});
