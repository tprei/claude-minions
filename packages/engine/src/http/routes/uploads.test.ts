import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { registerUploadsRoute } from "./uploads.js";
import type { EngineContext } from "../../context.js";

function buildContext(workspaceDir: string): EngineContext {
  return { workspaceDir } as unknown as EngineContext;
}

async function buildApp(workspaceDir: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  registerUploadsRoute(app, buildContext(workspaceDir));
  await app.ready();
  return app;
}

function multipartBody(filename: string, contentType: string, data: Buffer): { body: Buffer; boundary: string } {
  const boundary = `----TestBoundary${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, data, tail]), boundary };
}

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

describe("uploads route", () => {
  let workspaceDir: string;
  let app: FastifyInstance;

  before(async () => {
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "minions-uploads-test-"));
    app = await buildApp(workspaceDir);
  });

  after(async () => {
    await app.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("uploads a tiny PNG and returns a content-addressed url", async () => {
    const { body, boundary } = multipartBody("tiny.png", "image/png", TINY_PNG);
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(res.statusCode, 201);
    const json = res.json() as { url: string; name: string; mimeType: string; byteSize: number };
    assert.match(json.url, /^\/api\/uploads\/[0-9a-f]{64}\.png$/);
    assert.equal(json.mimeType, "image/png");
    assert.equal(json.byteSize, TINY_PNG.length);
    assert.equal(json.name, "tiny.png");

    const filename = json.url.slice("/api/uploads/".length);
    assert.ok(existsSync(path.join(workspaceDir, "uploads", filename)));
  });

  it("rejects unsupported mime types with 415", async () => {
    const { body, boundary } = multipartBody("file.txt", "text/plain", Buffer.from("hello"));
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(res.statusCode, 415);
    assert.equal((res.json() as { error: string }).error, "unsupported_media_type");
  });

  it("rejects files over 5MB with 413", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 16, 0xff);
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47;
    const { body, boundary } = multipartBody("big.png", "image/png", big);
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(res.statusCode, 413);
    assert.equal((res.json() as { error: string }).error, "payload_too_large");
  });

  it("rejects path traversal in GET filename with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/uploads/..%2Fetc%2Fpasswd",
    });
    assert.equal(res.statusCode, 400);
  });

  it("round-trips uploaded bytes via GET", async () => {
    const { body, boundary } = multipartBody("trip.png", "image/png", TINY_PNG);
    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(upload.statusCode, 201);
    const url = (upload.json() as { url: string }).url;

    const get = await app.inject({ method: "GET", url });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers["content-type"], "image/png");
    assert.deepEqual(Buffer.from(get.rawPayload), TINY_PNG);
  });
});
