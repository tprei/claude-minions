#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";

const slug = process.env["MINIONS_SESSION_SLUG"];
const token = process.env["MINIONS_TOKEN"];
const baseUrl = process.env["MINIONS_URL"];
const probeMode = process.env["MINIONS_PROBE"] === "1";

function writeJsonRpcError(id, code, message) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(payload + "\n");
}

function writeJsonRpcResult(id, result) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(payload + "\n");
}

if (!probeMode && (!slug || !token || !baseUrl)) {
  writeJsonRpcError(null, -32603, "minions-mcp-bridge: missing env (MINIONS_SESSION_SLUG, MINIONS_TOKEN, MINIONS_URL)");
  process.exit(1);
}

const PROBE_TOOLS = [
  { name: "propose_memory" },
  { name: "list_memories" },
  { name: "get_memory" },
];

function handleProbeLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    writeJsonRpcError(null, -32700, "minions-mcp-bridge: parse error");
    return;
  }
  if (!req || typeof req !== "object") {
    writeJsonRpcError(null, -32600, "minions-mcp-bridge: invalid request");
    return;
  }
  const id = "id" in req ? (req.id ?? null) : null;
  switch (req.method) {
    case "initialize":
      writeJsonRpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "minions-memory-bridge-probe", version: "1.0.0" },
      });
      return;
    case "ping":
      writeJsonRpcResult(id, {});
      return;
    case "tools/list":
      writeJsonRpcResult(id, { tools: PROBE_TOOLS });
      return;
    default:
      writeJsonRpcError(id, -32601, `minions-mcp-bridge: probe-mode does not handle ${req.method}`);
      return;
  }
}

function tryExtractId(line) {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === "object" && "id" in obj) {
      return obj.id ?? null;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

async function forward(line) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/mcp/${encodeURIComponent(slug)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ line }),
    });
  } catch (err) {
    const id = tryExtractId(line);
    writeJsonRpcError(id, -32603, `minions-mcp-bridge: fetch failed: ${String(err)}`);
    return;
  }

  if (res.status !== 200) {
    const id = tryExtractId(line);
    let detail = `${res.status} ${res.statusText}`;
    try {
      const txt = await res.text();
      if (txt) detail += ` ${txt.slice(0, 200)}`;
    } catch {
      /* ignore */
    }
    writeJsonRpcError(id, -32603, `minions-mcp-bridge: engine returned ${detail}`);
    return;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    const id = tryExtractId(line);
    writeJsonRpcError(id, -32603, `minions-mcp-bridge: invalid JSON from engine: ${String(err)}`);
    return;
  }

  if (!json || typeof json.line !== "string") {
    const id = tryExtractId(line);
    writeJsonRpcError(id, -32603, "minions-mcp-bridge: engine response missing line");
    return;
  }

  if (json.line.length === 0) return;
  process.stdout.write(json.line + "\n");
}

const rl = readline.createInterface({ input: process.stdin });

const queue = [];
let working = false;

async function drain() {
  if (working) return;
  working = true;
  while (queue.length > 0) {
    const line = queue.shift();
    await forward(line);
  }
  working = false;
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  if (probeMode) {
    handleProbeLine(line);
    return;
  }
  queue.push(line);
  drain();
});

rl.on("close", () => {
  const interval = setInterval(() => {
    if (!working && queue.length === 0) {
      clearInterval(interval);
      process.exit(0);
    }
  }, 10);
});
