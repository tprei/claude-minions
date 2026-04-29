import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "./env.js";
import { isEngineError } from "./errors.js";

const LOCALHOST_DEFAULTS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

const safeEnv = { MINIONS_TOKEN: "unit-test-secret" } as NodeJS.ProcessEnv;

describe("loadEnv host binding", () => {
  it("defaults host to 127.0.0.1 (loopback only)", () => {
    const env = loadEnv(safeEnv);
    assert.equal(env.host, "127.0.0.1");
  });

  it("honors explicit MINIONS_HOST=0.0.0.0 as an opt-in", () => {
    const env = loadEnv({ ...safeEnv, MINIONS_HOST: "0.0.0.0" });
    assert.equal(env.host, "0.0.0.0");
  });

  it("honors arbitrary explicit hosts", () => {
    const env = loadEnv({ ...safeEnv, MINIONS_HOST: "10.0.0.5" });
    assert.equal(env.host, "10.0.0.5");
  });
});

describe("loadEnv token validation", () => {
  it("throws an EngineError when MINIONS_TOKEN is unset", () => {
    assert.throws(
      () => loadEnv({}),
      (err) => isEngineError(err) && /MINIONS_TOKEN/.test(err.message),
    );
  });

  it("throws an EngineError when MINIONS_TOKEN is empty", () => {
    assert.throws(
      () => loadEnv({ MINIONS_TOKEN: "" }),
      (err) => isEngineError(err) && /MINIONS_TOKEN/.test(err.message),
    );
  });

  it("throws an EngineError when MINIONS_TOKEN is the literal 'changeme'", () => {
    assert.throws(
      () => loadEnv({ MINIONS_TOKEN: "changeme" }),
      (err) => isEngineError(err) && /MINIONS_TOKEN/.test(err.message),
    );
  });

  it("permits 'changeme' when MINIONS_ALLOW_INSECURE_TOKEN=1 is set", () => {
    const env = loadEnv({ MINIONS_TOKEN: "changeme", MINIONS_ALLOW_INSECURE_TOKEN: "1" });
    assert.equal(env.token, "changeme");
  });

  it("permits an empty token when MINIONS_ALLOW_INSECURE_TOKEN=1 is set", () => {
    const env = loadEnv({ MINIONS_ALLOW_INSECURE_TOKEN: "1" });
    assert.equal(env.token, "");
  });

  it("does not bypass the check for any value other than '1'", () => {
    assert.throws(
      () =>
        loadEnv({
          MINIONS_TOKEN: "changeme",
          MINIONS_ALLOW_INSECURE_TOKEN: "true",
        }),
      (err) => isEngineError(err) && /MINIONS_TOKEN/.test(err.message),
    );
  });

  it("accepts a non-default token without the escape hatch", () => {
    const env = loadEnv({ MINIONS_TOKEN: "a-real-secret" });
    assert.equal(env.token, "a-real-secret");
  });
});

describe("loadEnv CORS origins", () => {
  it("returns the documented localhost defaults when MINIONS_CORS_ORIGINS is unset", () => {
    const env = loadEnv(safeEnv);
    assert.deepEqual(env.corsOrigins, LOCALHOST_DEFAULTS);
  });

  it("returns the documented localhost defaults when MINIONS_CORS_ORIGINS is empty string", () => {
    const env = loadEnv({ ...safeEnv, MINIONS_CORS_ORIGINS: "" });
    assert.deepEqual(env.corsOrigins, LOCALHOST_DEFAULTS);
  });

  it("returns the documented localhost defaults when MINIONS_CORS_ORIGINS is whitespace", () => {
    const env = loadEnv({ ...safeEnv, MINIONS_CORS_ORIGINS: "   " });
    assert.deepEqual(env.corsOrigins, LOCALHOST_DEFAULTS);
  });

  it("returns an empty list only when MINIONS_CORS_ORIGINS is the literal 'none'", () => {
    const env = loadEnv({ ...safeEnv, MINIONS_CORS_ORIGINS: "none" });
    assert.deepEqual(env.corsOrigins, []);
  });

  it("parses comma-separated origins and trims whitespace", () => {
    const env = loadEnv({
      ...safeEnv,
      MINIONS_CORS_ORIGINS: "https://a.example.com, https://b.example.com",
    });
    assert.deepEqual(env.corsOrigins, ["https://a.example.com", "https://b.example.com"]);
  });
});
