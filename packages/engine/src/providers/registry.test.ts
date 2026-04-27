import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getProvider, listProviders } from "./registry.js";
import { claudeCodeProvider } from "./claudeCode.js";
import { mockProvider } from "./mock.js";
import { EngineError, isEngineError } from "../errors.js";

describe("provider registry", () => {
  test("getProvider('claude-code') returns the claude-code provider (not mock)", () => {
    const p = getProvider("claude-code");
    assert.equal(p, claudeCodeProvider);
    assert.equal(p.name, "claude-code");
    assert.notEqual(p, mockProvider);
  });

  test("getProvider('mock') returns the mock provider", () => {
    const p = getProvider("mock");
    assert.equal(p, mockProvider);
    assert.equal(p.name, "mock");
  });

  test("getProvider('nonsense') throws EngineError with kind 'not_found'", () => {
    assert.throws(
      () => getProvider("nonsense"),
      (err: unknown) => {
        assert.ok(isEngineError(err), "should be an EngineError");
        assert.equal((err as EngineError).code, "not_found");
        return true;
      },
    );
  });

  test("listProviders yields entries for both names with callable ready()", () => {
    const entries = listProviders();
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["claude-code", "mock"]);
    for (const entry of entries) {
      assert.equal(typeof entry.ready, "function");
    }
  });

  test("mock provider readiness reports ready", async () => {
    const entries = listProviders();
    const mock = entries.find((e) => e.name === "mock");
    assert.ok(mock, "mock entry must exist");
    const result = await mock!.ready();
    assert.equal(result, true);
  });

  test("claude-code readiness returns true or the documented degraded reason", async () => {
    const entries = listProviders();
    const claude = entries.find((e) => e.name === "claude-code");
    assert.ok(claude, "claude-code entry must exist");
    const result = await claude!.ready();
    if (result !== true) {
      assert.equal(typeof result, "string");
      assert.equal(result, "claude CLI not found in $PATH");
    }
  });
});
