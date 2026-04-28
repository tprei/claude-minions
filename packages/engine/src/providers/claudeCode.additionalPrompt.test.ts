import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs, buildResumeArgs } from "./claudeCode.js";

describe("claudeCodeProvider argv building (additionalPrompt)", () => {
  test("buildSpawnArgs: additionalPrompt is appended to the prompt argv", () => {
    const tag = "TAG-SPAWN-9F4XQ";
    const args = buildSpawnArgs({
      sessionSlug: "s1",
      worktree: "/tmp/x",
      prompt: "do the thing",
      env: {},
      additionalPrompt: `hello ${tag}`,
    });

    const dashIdx = args.indexOf("--");
    assert.ok(dashIdx >= 0, "expected -- separator");
    const promptArg = args[dashIdx + 1] ?? "";
    assert.ok(
      promptArg.includes("do the thing"),
      `prompt argv should still contain original prompt (got: ${promptArg})`,
    );
    assert.ok(
      promptArg.includes(tag),
      `prompt argv should contain additionalPrompt tag (got: ${promptArg})`,
    );
    assert.ok(
      args.includes("--print"),
      "spawn argv should still use --print mode",
    );
  });

  test("buildSpawnArgs: empty additionalPrompt does not change prompt argv", () => {
    const args = buildSpawnArgs({
      sessionSlug: "s2",
      worktree: "/tmp/x",
      prompt: "just the original",
      env: {},
      additionalPrompt: "",
    });

    const dashIdx = args.indexOf("--");
    assert.ok(dashIdx >= 0);
    const promptArg = args[dashIdx + 1] ?? "";
    assert.equal(promptArg, "just the original");
  });

  test("buildResumeArgs: additionalPrompt becomes the prompt argv tagged as operator reply", () => {
    const tag = "TAG-RESUME-7B2WN";
    const args = buildResumeArgs({
      sessionSlug: "s3",
      worktree: "/tmp/x",
      externalId: "ext-2",
      env: {},
      additionalPrompt: `operator says ${tag}`,
    });

    assert.ok(args.includes("--resume"), "resume argv should include --resume flag");
    assert.ok(args.includes("ext-2"), "resume argv should include externalId");
    const dashIdx = args.indexOf("--");
    assert.ok(dashIdx >= 0, "expected -- separator added when additionalPrompt is set");
    const promptArg = args[dashIdx + 1] ?? "";
    assert.ok(
      promptArg.includes(tag),
      `resume prompt argv should contain additionalPrompt tag (got: ${promptArg})`,
    );
    assert.ok(
      args.includes("--print"),
      "resume argv should still use --print mode",
    );
  });

  test("buildResumeArgs: no additionalPrompt means no -- separator and no prompt argv", () => {
    const args = buildResumeArgs({
      sessionSlug: "s4",
      worktree: "/tmp/x",
      externalId: "ext-3",
      env: {},
    });

    assert.ok(!args.includes("--"), "no -- separator should be added when additionalPrompt is unset");
  });
});
