import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAuthPreHandler, extractBearerToken } from "./auth.js";

describe("extractBearerToken", () => {
  it("extracts token from Authorization header", () => {
    const req = {
      headers: { authorization: "Bearer mysecret" },
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req), "mysecret");
  });

  it("extracts token from query string", () => {
    const req = {
      headers: {},
      query: { token: "querytoken" },
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req), "querytoken");
  });

  it("returns null when neither header nor query present", () => {
    const req = {
      headers: {},
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req), null);
  });

  it("returns null for non-Bearer authorization", () => {
    const req = {
      headers: { authorization: "Basic abc" },
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    assert.equal(extractBearerToken(req), null);
  });
});

describe("buildAuthPreHandler", () => {
  function makeReply(statusCode = 200): {
    status: (code: number) => { send: (body: unknown) => Promise<void> };
    sentStatus?: number;
    sentBody?: unknown;
  } {
    const reply = {
      sentStatus: undefined as number | undefined,
      sentBody: undefined as unknown,
      status(code: number) {
        reply.sentStatus = code;
        return {
          send: async (body: unknown) => {
            reply.sentBody = body;
          },
        };
      },
    };
    return reply;
  }

  it("passes through a valid bearer token", async () => {
    const handler = buildAuthPreHandler("correct-token");
    const req = {
      headers: { authorization: "Bearer correct-token" },
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    const reply = makeReply();
    await handler(req as never, reply as never);
    assert.equal(reply.sentStatus, undefined);
  });

  it("rejects a missing token with 401", async () => {
    const handler = buildAuthPreHandler("correct-token");
    const req = {
      headers: {},
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    const reply = makeReply();
    await handler(req as never, reply as never);
    assert.equal(reply.sentStatus, 401);
    assert.deepEqual((reply.sentBody as Record<string, unknown>)?.["error"], "unauthorized");
  });

  it("rejects an incorrect token with 401", async () => {
    const handler = buildAuthPreHandler("correct-token");
    const req = {
      headers: { authorization: "Bearer wrong-token" },
      query: {},
    } as unknown as Parameters<typeof extractBearerToken>[0];
    const reply = makeReply();
    await handler(req as never, reply as never);
    assert.equal(reply.sentStatus, 401);
    assert.deepEqual((reply.sentBody as Record<string, unknown>)?.["error"], "unauthorized");
  });

  it("accepts token from query string", async () => {
    const handler = buildAuthPreHandler("correct-token");
    const req = {
      headers: {},
      query: { token: "correct-token" },
    } as unknown as Parameters<typeof extractBearerToken>[0];
    const reply = makeReply();
    await handler(req as never, reply as never);
    assert.equal(reply.sentStatus, undefined);
  });
});
