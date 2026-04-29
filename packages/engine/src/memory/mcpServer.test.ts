import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import type { EngineContext } from "../context.js";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { EventBus } from "../bus/eventBus.js";
import { MemoryStore } from "./store.js";
import { resolveBridgeEntry, assertBridgeEntry, serveMcpStdio } from "./mcpServer.js";

function makeStubCtx(): EngineContext {
  const created: unknown[] = [];
  const stub = {
    memory: {
      list: () => [],
      get: (id: string) => (id === "m1" ? { id: "m1", title: "x" } : null),
      create: async (req: unknown) => {
        created.push(req);
        return { id: "new-mem", ...(req as object) };
      },
    },
    bus: {
      emit: () => {},
    },
  } as unknown as EngineContext;
  (stub as unknown as { _created: unknown[] })._created = created;
  return stub;
}

describe("serveMcpStdio MCP protocol", () => {
  test("initialize returns protocolVersion + serverInfo + tools capability", () => {
    const handle = serveMcpStdio("s1", makeStubCtx());
    const line = handle.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }));
    assert.ok(line, "expected response");
    const parsed = JSON.parse(line) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } } };
    assert.equal(parsed.result.protocolVersion, "2024-11-05");
    assert.equal(parsed.result.serverInfo.name, "minions-memory");
    assert.ok(parsed.result.capabilities.tools, "tools capability present");
  });

  test("notifications/initialized returns null (no response per JSON-RPC spec)", () => {
    const handle = serveMcpStdio("s1", makeStubCtx());
    const line = handle.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert.equal(line, null);
  });

  test("tools/list exposes propose_memory + list_memories + get_memory with inputSchema", () => {
    const handle = serveMcpStdio("s1", makeStubCtx());
    const line = handle.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    assert.ok(line);
    const parsed = JSON.parse(line) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    const names = parsed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_memory", "list_memories", "propose_memory"]);
    for (const t of parsed.result.tools) {
      assert.ok(t.inputSchema, `${t.name} has inputSchema`);
    }
  });

  test("tools/call propose_memory invokes ctx.memory.create + returns content array", async () => {
    const ctx = makeStubCtx();
    const handle = serveMcpStdio("s1", ctx);
    const line = handle.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "propose_memory",
        arguments: { kind: "engineering", title: "T", body: "B", scope: "global" },
      },
    }));
    assert.ok(line);
    const parsed = JSON.parse(line) as { result: { content: Array<{ type: string; text: string }> } };
    assert.equal(parsed.result.content[0]?.type, "text");
    assert.equal(parsed.result.content[0]?.text, "queued");
    await new Promise((r) => setTimeout(r, 10));
    const created = (ctx as unknown as { _created: Array<{ kind: string; title: string }> })._created;
    assert.equal(created.length, 1);
    assert.equal(created[0]?.kind, "engineering");
  });

  test("tools/call rejects missing required field with -32602", () => {
    const handle = serveMcpStdio("s1", makeStubCtx());
    const line = handle.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "propose_memory", arguments: { kind: "engineering" } },
    }));
    assert.ok(line);
    const parsed = JSON.parse(line) as { error: { code: number; message: string } };
    assert.equal(parsed.error.code, -32602);
    assert.match(parsed.error.message, /title/);
  });

  test("tools/call unknown tool returns -32601", () => {
    const handle = serveMcpStdio("s1", makeStubCtx());
    const line = handle.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    }));
    assert.ok(line);
    const parsed = JSON.parse(line) as { error: { code: number } };
    assert.equal(parsed.error.code, -32601);
  });

  test("ping returns empty object", () => {
    const handle = serveMcpStdio("s1", makeStubCtx());
    const line = handle.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }));
    assert.ok(line);
    const parsed = JSON.parse(line) as { result: object };
    assert.deepEqual(parsed.result, {});
  });

  test("legacy direct propose_memory method still works for back-compat", async () => {
    const ctx = makeStubCtx();
    const handle = serveMcpStdio("s1", ctx);
    const line = handle.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "propose_memory",
      params: { kind: "engineering", title: "L", body: "B", scope: "global" },
    }));
    assert.ok(line);
    const parsed = JSON.parse(line) as { result: { content: Array<{ text: string }> } };
    assert.equal(parsed.result.content[0]?.text, "queued");
  });
});

describe("resolveBridgeEntry / assertBridgeEntry", () => {
  test("resolveBridgeEntry locates the source bridge during dev/test", () => {
    const found = resolveBridgeEntry();
    assert.ok(found, "expected bridge entry to be found in dev tree");
    assert.match(found!, /mcpBridge\.mjs$/);
  });

  test("assertBridgeEntry rejects a null path with ok=false", () => {
    const result = assertBridgeEntry(null);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /not found/i);
  });

  test("assertBridgeEntry rejects a path that does not exist", () => {
    const result = assertBridgeEntry("/no/such/file.mjs");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /missing/i);
  });

  test("assertBridgeEntry accepts the real bridge entry", () => {
    const found = resolveBridgeEntry();
    const result = assertBridgeEntry(found);
    assert.equal(result.ok, true);
    assert.equal(result.path, found);
  });
});

interface IntegrationHarness {
  bridgeScript: string;
  ctx: EngineContext;
  store: MemoryStore;
  bus: EventBus;
  url: string;
  shutdown: () => Promise<void>;
}

async function startIntegrationHarness(token: string, slug: string): Promise<IntegrationHarness> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bridgeScript = path.resolve(here, "mcpBridge.mjs");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, createLogger("error"));
  const store = new MemoryStore(db);
  const bus = new EventBus();

  const ctx = {
    sessions: {
      get: (s: string) => (s === slug ? ({ slug } as unknown as object) : null),
    },
    memory: {
      list: () => store.list(),
      get: (id: string) => store.getById(id),
      create: async (req: {
        kind: import("@minions/shared").MemoryKind;
        title: string;
        body: string;
        scope: "global" | "repo";
        repoId?: string;
        proposedFromSession?: string;
      }) => {
        const memory = store.insert({
          kind: req.kind,
          status: "pending",
          scope: req.scope,
          repoId: req.repoId,
          pinned: false,
          title: req.title,
          body: req.body,
          proposedBy: undefined,
          proposedFromSession: req.proposedFromSession,
          reviewedBy: undefined,
          reviewedAt: undefined,
          rejectionReason: undefined,
          supersedes: undefined,
        });
        bus.emit({ kind: "memory_proposed", memory });
        return memory;
      },
    },
    bus,
  } as unknown as EngineContext;

  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      await reply.status(401).send({ error: "unauthorized" });
    }
  });
  app.post("/api/mcp/:sessionSlug", async (req, reply) => {
    const { sessionSlug } = req.params as { sessionSlug: string };
    if (!ctx.sessions.get(sessionSlug)) {
      await reply.status(404).send({ error: "not_found" });
      return;
    }
    const body = req.body as { line?: string };
    if (typeof body.line !== "string") {
      await reply.status(400).send({ error: "bad_request" });
      return;
    }
    const handle = serveMcpStdio(sessionSlug, ctx);
    const out = handle.handleLine(body.line);
    await reply.send({ line: out ?? "" });
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind harness");
  }
  const url = `http://127.0.0.1:${address.port}`;

  const shutdown = async (): Promise<void> => {
    await app.close();
    db.close();
  };

  return { bridgeScript, ctx, store, bus, url, shutdown };
}

async function sendBridgeRequest(
  child: ReturnType<typeof spawn>,
  rl: readline.Interface,
  request: object,
): Promise<unknown> {
  const lineP = new Promise<string>((resolve) => rl.once("line", (l) => resolve(l)));
  child.stdin!.write(JSON.stringify(request) + "\n");
  const line = await lineP;
  return JSON.parse(line) as unknown;
}

describe("mcpBridge subprocess integration with serveMcpStdio + memory store", () => {
  test("tools/list round-trip exposes propose_memory + propose_memory creates a pending row", async () => {
    const token = "integration-token";
    const slug = "integ-sess-1";
    const harness = await startIntegrationHarness(token, slug);
    const child = spawn(process.execPath, [harness.bridgeScript], {
      env: {
        ...process.env,
        MINIONS_SESSION_SLUG: slug,
        MINIONS_TOKEN: token,
        MINIONS_URL: harness.url,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const rl = readline.createInterface({ input: child.stdout! });

      const toolsList = (await sendBridgeRequest(child, rl, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { result?: { tools?: { name?: string }[] } };
      const names = (toolsList.result?.tools ?? []).map((t) => t.name);
      assert.ok(names.includes("propose_memory"), `expected propose_memory in tools/list, got ${names.join(",")}`);
      assert.ok(names.includes("list_memories"));
      assert.ok(names.includes("get_memory"));

      const propose = (await sendBridgeRequest(child, rl, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "propose_memory",
          arguments: {
            kind: "project",
            title: "Bridge integration",
            body: "Integration test confirms bridge can land memories.",
            scope: "global",
          },
        },
      })) as { result?: { content?: { text?: string }[] } };
      assert.equal(propose.result?.content?.[0]?.text, "queued");

      const deadline = Date.now() + 5000;
      let memories: import("@minions/shared").Memory[] = [];
      while (Date.now() < deadline) {
        memories = harness.store.list({ status: "pending" });
        if (memories.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(memories.length, 1, "expected exactly one pending memory after propose_memory");
      assert.equal(memories[0]!.title, "Bridge integration");
      assert.equal(memories[0]!.status, "pending");
      assert.equal(memories[0]!.proposedFromSession, slug);
    } finally {
      child.stdin!.end();
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => {
          if (!child.killed) child.kill("SIGTERM");
          resolve();
        }, 1000);
      });
      await harness.shutdown();
    }
  });
});
