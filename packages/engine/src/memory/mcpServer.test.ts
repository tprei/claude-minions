import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { EngineContext } from "../context.js";
import { serveMcpStdio } from "./mcpServer.js";

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
