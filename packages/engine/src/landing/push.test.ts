import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyPushError } from "./push.js";

describe("classifyPushError", () => {
  test("classifies ECONNRESET as transient", () => {
    assert.equal(
      classifyPushError("fatal: unable to access 'https://github.com/x/y.git/': ECONNRESET"),
      "transient",
    );
  });

  test("classifies ETIMEDOUT as transient", () => {
    assert.equal(
      classifyPushError("fatal: connect ETIMEDOUT 140.82.121.4:443"),
      "transient",
    );
  });

  test("classifies 'connection timed out' as transient", () => {
    assert.equal(
      classifyPushError("fatal: unable to access: Connection timed out after 30000ms"),
      "transient",
    );
  });

  test("classifies 'Could not resolve host' as transient", () => {
    assert.equal(
      classifyPushError("fatal: unable to access 'https://github.com/foo/bar/': Could not resolve host: github.com"),
      "transient",
    );
  });

  test("classifies HTTP 502 Bad Gateway as transient", () => {
    assert.equal(
      classifyPushError("fatal: unable to access: The requested URL returned error: 502 Bad Gateway"),
      "transient",
    );
  });

  test("classifies HTTP 503 Service Unavailable as transient", () => {
    assert.equal(
      classifyPushError("fatal: The requested URL returned error: 503 Service Unavailable"),
      "transient",
    );
  });

  test("classifies 'Authentication failed' as transient", () => {
    assert.equal(
      classifyPushError("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'"),
      "transient",
    );
  });

  test("classifies 'unexpectedly closed the connection' as transient", () => {
    assert.equal(
      classifyPushError("fatal: the remote end hung up unexpectedly"),
      "transient",
    );
  });

  test("classifies merge conflict as conflict", () => {
    assert.equal(
      classifyPushError("error: failed to push some refs: rebase conflict in src/foo.ts"),
      "conflict",
    );
  });

  test("classifies 'CONFLICT (content)' as conflict", () => {
    assert.equal(
      classifyPushError("CONFLICT (content): Merge conflict in foo.ts"),
      "conflict",
    );
  });

  test("classifies generic upstream rejection as fatal", () => {
    assert.equal(
      classifyPushError("error: failed to push some refs to 'https://github.com/x/y.git'"),
      "fatal",
    );
  });

  test("classifies non-fast-forward without conflict as fatal", () => {
    assert.equal(
      classifyPushError("Updates were rejected because the remote contains work that you do not have locally"),
      "fatal",
    );
  });
});
