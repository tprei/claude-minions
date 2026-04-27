import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeScript = path.resolve(here, "mcpBridge.mjs");

interface MockServer {
  app: FastifyInstance;
  url: string;
  received: Array<{ slug: string; line: string; auth: string | undefined }>;
}

async function startMockEngine(token: string): Promise<MockServer> {
  const received: MockServer["received"] = [];
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      await reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.post("/api/mcp/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = req.body as { line: string };
    received.push({ slug, line: body.line, auth: req.headers.authorization });
    const parsed = JSON.parse(body.line) as { id: number | string | null; method: string };
    const responseLine = JSON.stringify({
      jsonrpc: "2.0",
      id: parsed.id,
      result: { echoed: parsed.method, slug },
    });
    await reply.send({ line: responseLine });
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind mock engine");
  }
  return { app, url: `http://127.0.0.1:${address.port}`, received };
}

describe("mcpBridge subprocess", () => {
  test("forwards stdin lines to engine and writes engine response to stdout", async () => {
    const token = "test-token-123";
    const slug = "sess-abc";
    const mock = await startMockEngine(token);

    try {
      const child = spawn(process.execPath, [bridgeScript], {
        env: {
          ...process.env,
          MINIONS_SESSION_SLUG: slug,
          MINIONS_TOKEN: token,
          MINIONS_URL: mock.url,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const rl = readline.createInterface({ input: child.stdout });
      const lineP = new Promise<string>((resolve) => {
        rl.once("line", (l) => resolve(l));
      });

      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "list_memories",
        params: {},
      });
      child.stdin.write(request + "\n");

      const responseLine = await lineP;
      const parsed = JSON.parse(responseLine) as {
        jsonrpc: string;
        id: number;
        result: { echoed: string; slug: string };
      };
      assert.equal(parsed.jsonrpc, "2.0");
      assert.equal(parsed.id, 7);
      assert.equal(parsed.result.echoed, "list_memories");
      assert.equal(parsed.result.slug, slug);

      assert.equal(mock.received.length, 1);
      assert.equal(mock.received[0]!.slug, slug);
      assert.equal(mock.received[0]!.auth, `Bearer ${token}`);

      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      assert.equal(exitCode, 0);
    } finally {
      await mock.app.close();
    }
  });

  test("writes JSON-RPC error and exits non-zero when env is missing", async () => {
    const child = spawn(process.execPath, [bridgeScript], {
      env: {
        ...process.env,
        MINIONS_SESSION_SLUG: "",
        MINIONS_TOKEN: "",
        MINIONS_URL: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: child.stdout });
    const lineP = new Promise<string>((resolve) => {
      rl.once("line", (l) => resolve(l));
    });

    const exitP = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    const responseLine = await lineP;
    const parsed = JSON.parse(responseLine) as { error: { code: number; message: string } };
    assert.equal(parsed.error.code, -32603);
    assert.match(parsed.error.message, /missing env/);

    const exitCode = await exitP;
    assert.equal(exitCode, 1);
  });
});
