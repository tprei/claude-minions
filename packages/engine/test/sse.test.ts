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
import { connectSseClient } from "./fixture/eventsource.js";

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
  close: () => Promise<void>;
}

async function createTestEngine(envOverrides: Partial<EngineEnv> = {}): Promise<TestEngine> {
  const port = await getFreePort();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minions-sse-test-"));
  const baseEnv = loadEnv({ MINIONS_TOKEN: "test-token-sse" });
  const env: EngineEnv = {
    ...baseEnv,
    port,
    host: "127.0.0.1",
    token: "test-token-sse",
    corsOrigins: ["http://localhost:5173"],
    workspace,
    provider: "mock",
    logLevel: "error",
    vapid: null,
    resourceSampleSec: 99999,
    loopTickSec: 99999,
    loopReservedInteractive: 4,
    ssePingSec: 25,
    ...envOverrides,
  };
  const log = createLogger(env.logLevel, { service: "test" });
  const ctx = await createEngine(env, log);
  return {
    ctx,
    baseUrl: `http://127.0.0.1:${port}`,
    token: env.token,
    close: async () => {
      try {
        await ctx.shutdown();
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  };
}

function insertSession(ctx: EngineContext, slug: string): void {
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
      slug, slug, "test", "task", "running",
      null, null, null, null, null,
      null, null,
      null, null, null, 0, null, null, null,
      "[]", "[]",
      0, 0, 0,
      0, 0,
      0, 0, 0,
      "mock", null,
      now, now, null, null, null,
      null, null, null, null, "{}",
    );
}

function insertTranscriptEvent(ctx: EngineContext, slug: string, seq: number): void {
  const id = `evt-${slug}-${seq}`;
  const body = JSON.stringify({ text: `event ${seq}` });
  const ts = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO transcript_events(id, session_slug, seq, turn, kind, body, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, slug, seq, 0, "assistant_text", body, ts);
}

after(() => {
  setImmediate(() => process.exit(0));
});

describe("engine SSE + transcript backfill (T31)", () => {
  it("emits a hello frame on connect with apiVersion", async () => {
    const harness = await createTestEngine();
    try {
      const client = await connectSseClient(`${harness.baseUrl}/api/events`, harness.token);
      try {
        const iter = client.events[Symbol.asyncIterator]();
        const first = await iter.next();
        assert.equal(first.done, false);
        const ev = first.value;
        assert.ok(ev);
        assert.equal(ev.event, "hello");
        const data = ev.data as { apiVersion?: string; kind?: string };
        assert.equal(data.apiVersion, harness.ctx.env.apiVersion);
        assert.equal(data.kind, "hello");
      } finally {
        client.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("emits ping events at the configured cadence", async () => {
    const harness = await createTestEngine({ ssePingSec: 1 });
    try {
      const client = await connectSseClient(`${harness.baseUrl}/api/events`, harness.token);
      const deadline = Date.now() + 2500;
      let pingCount = 0;
      try {
        for await (const ev of client.events) {
          if (ev.event === "ping") pingCount++;
          if (Date.now() >= deadline) break;
        }
      } finally {
        client.close();
      }
      assert.ok(
        pingCount >= 2,
        `expected at least 2 ping events in ~2.5s with ssePingSec=1, got ${pingCount}`,
      );
    } finally {
      await harness.close();
    }
  });

  it("backfills only the events newer than ?since", async () => {
    const harness = await createTestEngine();
    try {
      const slug = "backfill-test";
      insertSession(harness.ctx, slug);
      for (let seq = 0; seq < 5; seq++) {
        insertTranscriptEvent(harness.ctx, slug, seq);
      }

      const client = await connectSseClient(`${harness.baseUrl}/api/events`, harness.token);
      const lastSeenSeq = 4;
      client.close();

      for (let seq = 5; seq < 8; seq++) {
        insertTranscriptEvent(harness.ctx, slug, seq);
      }

      const res = await fetch(
        `${harness.baseUrl}/api/sessions/${slug}/transcript?since=${lastSeenSeq}`,
        { headers: { Authorization: `Bearer ${harness.token}` } },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: Array<{ seq: number }> };
      assert.deepEqual(
        body.items.map((i) => i.seq),
        [5, 6, 7],
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed ?since values with 400", async () => {
    const harness = await createTestEngine();
    try {
      const slug = "bad-since-test";
      insertSession(harness.ctx, slug);
      const headers = { Authorization: `Bearer ${harness.token}` };
      const r1 = await fetch(
        `${harness.baseUrl}/api/sessions/${slug}/transcript?since=abc`,
        { headers },
      );
      assert.equal(r1.status, 400);
      const r2 = await fetch(
        `${harness.baseUrl}/api/sessions/${slug}/transcript?since=-1`,
        { headers },
      );
      assert.equal(r2.status, 400);
    } finally {
      await harness.close();
    }
  });
});
