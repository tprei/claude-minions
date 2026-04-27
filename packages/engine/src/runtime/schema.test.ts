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
});
