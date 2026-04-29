import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildAutoCommitEnv } from "./autoCommit.js";

describe("buildAutoCommitEnv", () => {
  test("strips editor env vars even when set in the source environment", () => {
    const env = buildAutoCommitEnv({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_EDITOR: "true",
      EDITOR: "vim",
      GIT_SEQUENCE_EDITOR: "vim",
      GIT_PAGER: "less",
    });

    assert.equal(env.GIT_EDITOR, undefined, "GIT_EDITOR must not propagate to git subprocess");
    assert.equal(env.EDITOR, undefined, "EDITOR must not propagate to git subprocess");
    assert.equal(env.GIT_SEQUENCE_EDITOR, undefined, "GIT_SEQUENCE_EDITOR must not propagate");
    assert.equal(env.GIT_PAGER, undefined, "GIT_PAGER must not propagate");
  });

  test("preserves non-editor env vars", () => {
    const env = buildAutoCommitEnv({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_EDITOR: "true",
      CUSTOM_VAR: "kept",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/test");
    assert.equal(env.CUSTOM_VAR, "kept");
  });

  test("sets author and committer identity for the engine", () => {
    const env = buildAutoCommitEnv({});

    assert.equal(env.GIT_AUTHOR_NAME, "minions-engine");
    assert.equal(env.GIT_AUTHOR_EMAIL, "engine@minions.local");
    assert.equal(env.GIT_COMMITTER_NAME, "minions-engine");
    assert.equal(env.GIT_COMMITTER_EMAIL, "engine@minions.local");
  });

  test("identity overrides any inherited GIT_AUTHOR_*/GIT_COMMITTER_* values", () => {
    const env = buildAutoCommitEnv({
      GIT_AUTHOR_NAME: "external",
      GIT_AUTHOR_EMAIL: "external@example.com",
      GIT_COMMITTER_NAME: "external",
      GIT_COMMITTER_EMAIL: "external@example.com",
    });

    assert.equal(env.GIT_AUTHOR_NAME, "minions-engine");
    assert.equal(env.GIT_AUTHOR_EMAIL, "engine@minions.local");
    assert.equal(env.GIT_COMMITTER_NAME, "minions-engine");
    assert.equal(env.GIT_COMMITTER_EMAIL, "engine@minions.local");
  });
});
