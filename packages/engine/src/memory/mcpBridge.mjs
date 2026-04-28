#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";

const slug = process.env["MINIONS_SESSION_SLUG"];
const token = process.env["MINIONS_TOKEN"];
const baseUrl = process.env["MINIONS_URL"];

function writeJsonRpcError(id, code, message) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(payload + "\n");
}

if (!slug || !token || !baseUrl) {
  writeJsonRpcError(null, -32603, "minions-mcp-bridge: missing env (MINIONS_SESSION_SLUG, MINIONS_TOKEN, MINIONS_URL)");
  process.exit(1);
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
