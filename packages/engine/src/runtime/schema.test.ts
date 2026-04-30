import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runtimeConfigSchema } from "./schema.js";

describe("runtimeConfigSchema", () => {
  const fieldKeys = runtimeConfigSchema.fields.map((f) => f.key);

  const expectedKeys = [
    "dagMaxConcurrent",
    "loopMaxTotal",
    "loopReservedInteractive",
    "ciAutoFix",
    "quotaRetryBudget",
    "memoryMcpEnabled",
    "qualityTimeoutMs",
    "pushNotifyOnAttention",
    "judgeRubricDefault",
    "sseHeartbeatSec",
    "rebaseAutoResolverEnabled",
    "landingDefaultStrategy",
  ];

  for (const key of expectedKeys) {
    it(`contains field: ${key}`, () => {
      assert.ok(fieldKeys.includes(key), `Missing field: ${key}`);
    });
  }

  it("all fields have a default value", () => {
    for (const field of runtimeConfigSchema.fields) {
      assert.notEqual(
        field.default,
        undefined,
        `Field ${field.key} has no default`,
      );
    }
  });

  it("number fields have min/max constraints", () => {
    for (const field of runtimeConfigSchema.fields) {
      if (field.type === "number") {
        assert.ok(
          field.min !== undefined && field.max !== undefined,
          `Number field ${field.key} missing min/max`,
        );
      }
    }
  });

  it("sseHeartbeatSec has min=5 and max=120", () => {
    const field = runtimeConfigSchema.fields.find((f) => f.key === "sseHeartbeatSec");
    assert.ok(field);
    assert.equal(field.min, 5);
    assert.equal(field.max, 120);
  });

  it("landingDefaultStrategy is an enum with merge|squash|rebase", () => {
    const field = runtimeConfigSchema.fields.find((f) => f.key === "landingDefaultStrategy");
    assert.ok(field);
    assert.equal(field.type, "enum");
    assert.deepEqual(field.enumValues, ["merge", "squash", "rebase"]);
    assert.equal(field.default, "squash");
  });

  it("groups list is non-empty", () => {
    assert.ok(runtimeConfigSchema.groups.length > 0);
  });

  it("every field declares an applies tag (live or restart)", () => {
    for (const field of runtimeConfigSchema.fields) {
      assert.ok(
        field.applies === "live" || field.applies === "restart",
        `Field ${field.key} must declare applies: 'live' | 'restart'`,
      );
    }
  });

  it("sseHeartbeatSec is tagged as restart", () => {
    const field = runtimeConfigSchema.fields.find((f) => f.key === "sseHeartbeatSec");
    assert.ok(field);
    assert.equal(field.applies, "restart");
  });

  it("ciAutoFix is tagged as live", () => {
    const field = runtimeConfigSchema.fields.find((f) => f.key === "ciAutoFix");
    assert.ok(field);
    assert.equal(field.applies, "live");
  });

  it("defaultSessionBudgetUsd is registered with default 0 and applies: live", () => {
    const field = runtimeConfigSchema.fields.find(
      (f) => f.key === "defaultSessionBudgetUsd",
    );
    assert.ok(field, "defaultSessionBudgetUsd field must be registered");
    assert.equal(field.type, "number");
    assert.equal(field.default, 0);
    assert.equal(field.min, 0);
    assert.equal(field.applies, "live");
  });
});
