// TODO: Web byConnection isolation regression deferred to a future vitest harness;
// this engine-side test is the closest current approximation. It guards against
// the engine ever serving cross-workspace data, which would unmask the very
// regressions the web-side connId-keyed stores (T13) are designed to prevent.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createEngine } from "../src/index.js";
import { createLogger } from "../src/logger.js";
import { loadEnv } from "../src/env.js";
import type { EngineContext } from "../src/context.js";
import type { EngineEnv } from "../src/env.js";
import type { Session, ListEnvelope } from "@minions/shared";

interface SseFrame {
  event: string;
  data: unknown;
}

interface SseClient {
  frames: SseFrame[];
  close: () => void;
  helloSeen: Promise<void>;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || !addr) {
        srv.close();
        reject(new Error("could not get free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

interface TestEngine {
  ctx: EngineContext;
  baseUrl: string;
  token: string;
  workspace: string;
  close: () => Promise<void>;
}

async function createTestEngine(suffix: string): Promise<TestEngine> {
  const port = await getFreePort();
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), `minions-iso-${suffix}-`),
  );
  const baseEnv = loadEnv({});
  const env: EngineEnv = {
    ...baseEnv,
    port,
    host: "127.0.0.1",
    token: `test-token-${suffix}`,
    corsOrigins: ["http://localhost:5173"],
    workspace,
    provider: "mock",
    logLevel: "error",
    vapid: null,
    resourceSampleSec: 99999,
    loopTickSec: 99999,
    loopReservedInteractive: 4,
    ssePingSec: 99999,
  };
  const log = createLogger(env.logLevel, { service: `iso-${suffix}` });
  const ctx = await createEngine(env, log);
  return {
    ctx,
    baseUrl: `http://127.0.0.1:${port}`,
    token: env.token,
    workspace,
    close: async () => {
      try {
        await ctx.shutdown();
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  };
}

async function connectSse(baseUrl: string, token: string): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let resolveHello: () => void = () => {};
  const helloSeen = new Promise<void>((r) => {
    resolveHello = r;
  });

  let buffer = "";
  let event = "message";
  let dataLines: string[] = [];

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") {
            if (dataLines.length > 0) {
              const raw = dataLines.join("\n");
              let data: unknown = raw;
              try {
                data = JSON.parse(raw);
              } catch {
                data = raw;
              }
              const frame: SseFrame = { event, data };
              frames.push(frame);
              if (frame.event === "hello") resolveHello();
            }
            event = "message";
            dataLines = [];
            continue;
          }
          if (line.startsWith(":")) continue;
          const colonIdx = line.indexOf(":");
          let field: string;
          let val: string;
          if (colonIdx < 0) {
            field = line;
            val = "";
          } else {
            field = line.slice(0, colonIdx);
            val = line.slice(colonIdx + 1);
            if (val.startsWith(" ")) val = val.slice(1);
          }
          if (field === "event") event = val;
          else if (field === "data") dataLines.push(val);
        }
      }
    } catch {
      // aborted or stream errored — surface as end-of-stream
    }
  })();

  return {
    frames,
    close: () => controller.abort(),
    helloSeen,
  };
}

function insertRunningSession(
  ctx: EngineContext,
  slug: string,
  title: string,
): Session {
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO sessions(
        slug, title, prompt, mode, status,
        ship_stage, repo_id, branch, base_branch, worktree_path,
        parent_slug, root_slug,
        pr_number, pr_url, pr_state, pr_draft, pr_base, pr_head, pr_title,
        attention, quick_actions,
        stats_turns, stats_input_tokens, stats_output_tokens,
        stats_cache_read_tokens, stats_cache_creation_tokens,
        stats_cost_usd, stats_duration_ms, stats_tool_calls,
        provider, model_hint,
        created_at, updated_at, started_at, completed_at, last_turn_at,
        dag_id, dag_node_id, loop_id, variant_of, metadata
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )`,
    )
    .run(
      slug, title, "test prompt", "task", "running",
      null, null, null, null, null,
      null, null,
      null, null, null, 0, null, null, null,
      "[]", "[]",
      0, 0, 0,
      0, 0,
      0, 0, 0,
      "mock", null,
      now, now, now, null, null,
      null, null, null, null, "{}",
    );
  const session = ctx.sessions.get(slug);
  assert.ok(session, "inserted session should be readable via sessions.get");
  return session;
}

async function fetchSessionList(
  baseUrl: string,
  token: string,
): Promise<ListEnvelope<Session>> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `GET /api/sessions returned ${res.status}`);
  return (await res.json()) as ListEnvelope<Session>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

after(() => {
  setImmediate(() => process.exit(0));
});

describe("multi-engine isolation (T32)", () => {
  it("session_created on engine A never reaches engine B's SSE or HTTP", async () => {
    const [engineA, engineB] = await Promise.all([
      createTestEngine("a-leak"),
      createTestEngine("b-leak"),
    ]);

    try {
      const [sseA, sseB] = await Promise.all([
        connectSse(engineA.baseUrl, engineA.token),
        connectSse(engineB.baseUrl, engineB.token),
      ]);

      try {
        await Promise.all([sseA.helloSeen, sseB.helloSeen]);
        await sleep(50);

        const slugA = "iso-a-001";
        const sessionA = insertRunningSession(
          engineA.ctx,
          slugA,
          "engine A session",
        );
        engineA.ctx.bus.emit({ kind: "session_created", session: sessionA });

        await sleep(500);

        const createdOnA = sseA.frames.filter(
          (f) => f.event === "session_created",
        );
        assert.equal(
          createdOnA.length,
          1,
          "engine A SSE should observe its own session_created exactly once",
        );
        const observedSlugA = (createdOnA[0]?.data as { session: Session })
          .session.slug;
        assert.equal(observedSlugA, slugA);

        const createdOnB = sseB.frames.filter(
          (f) => f.event === "session_created",
        );
        assert.equal(
          createdOnB.length,
          0,
          "engine B SSE must not see engine A's session_created",
        );

        const listB = await fetchSessionList(engineB.baseUrl, engineB.token);
        assert.equal(
          listB.items.length,
          0,
          "engine B HTTP listing must be empty (no DB leakage)",
        );

        const listA = await fetchSessionList(engineA.baseUrl, engineA.token);
        assert.equal(listA.items.length, 1);
        assert.equal(listA.items[0]?.slug, slugA);
      } finally {
        sseA.close();
        sseB.close();
      }
    } finally {
      await Promise.all([engineA.close(), engineB.close()]);
    }
  });

  it("colliding slugs across engines remain in isolated rows", async () => {
    const [engineA, engineB] = await Promise.all([
      createTestEngine("a-coll"),
      createTestEngine("b-coll"),
    ]);

    try {
      const collidingSlug = "abc";
      const sessionA = insertRunningSession(
        engineA.ctx,
        collidingSlug,
        "A's abc",
      );
      const sessionB = insertRunningSession(
        engineB.ctx,
        collidingSlug,
        "B's abc",
      );
      assert.equal(sessionA.slug, sessionB.slug);
      assert.notEqual(sessionA.title, sessionB.title);

      engineA.ctx.bus.emit({ kind: "session_created", session: sessionA });
      engineB.ctx.bus.emit({ kind: "session_created", session: sessionB });

      const listA = await fetchSessionList(engineA.baseUrl, engineA.token);
      const listB = await fetchSessionList(engineB.baseUrl, engineB.token);

      assert.equal(listA.items.length, 1);
      assert.equal(listB.items.length, 1);
      assert.equal(listA.items[0]?.title, "A's abc");
      assert.equal(listB.items[0]?.title, "B's abc");
    } finally {
      await Promise.all([engineA.close(), engineB.close()]);
    }
  });
});
