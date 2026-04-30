import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AttentionFlag, AttentionInboxItem, Session } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { EngineError, isEngineError } from "../../errors.js";
import { registerAttentionRoutes } from "./attention.js";

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

interface DismissCall {
  slug: string;
  kind: AttentionFlag["kind"];
}

function makeSession(slug: string, attention: AttentionFlag[], overrides: Partial<Session> = {}): Session {
  return {
    slug,
    title: `Title ${slug}`,
    prompt: "prompt",
    mode: "task",
    status: "waiting_input",
    childSlugs: [],
    attention,
    quickActions: [],
    stats: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
    provider: "test",
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("attention routes", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let sessionsList: Session[];
  let dismissCalls: DismissCall[];
  let auditCalls: AuditCall[];
  let busEvents: Array<{ kind: string; session?: Session }>;

  before(async () => {
    sessionsList = [];
    dismissCalls = [];
    auditCalls = [];
    busEvents = [];

    const ctx = {
      sessions: {
        list: () => sessionsList,
        dismissAttention: (slug: string, kind: AttentionFlag["kind"]) => {
          dismissCalls.push({ slug, kind });
          const session = sessionsList.find((s) => s.slug === slug);
          if (!session) {
            throw new EngineError("not_found", `Session ${slug} not found`);
          }
          const remaining = session.attention.filter((a) => a.kind !== kind);
          if (remaining.length === session.attention.length) {
            return session;
          }
          session.attention = remaining;
          busEvents.push({ kind: "session_updated", session });
          return session;
        },
      },
      bus: {
        emit: (ev: { kind: string; session?: Session }) => {
          busEvents.push(ev);
        },
      },
      audit: {
        record: (
          actor: string,
          action: string,
          target?: { kind: string; id: string },
          detail?: Record<string, unknown>,
        ) => {
          auditCalls.push({ actor, action, target, detail });
        },
      },
    } as unknown as EngineContext;

    app = Fastify({ logger: false });
    app.setErrorHandler(async (err, _req, reply) => {
      if (isEngineError(err)) {
        await reply.status(err.status).send(err.toJSON());
        return;
      }
      const e = err as Error;
      await reply.status(500).send({ error: "internal", message: e.message });
    });
    registerAttentionRoutes(app, ctx);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fastify did not return a network address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    sessionsList.length = 0;
    dismissCalls.length = 0;
    auditCalls.length = 0;
    busEvents.length = 0;
  });

  async function getItems(): Promise<{ status: number; body: { items: AttentionInboxItem[] } }> {
    const res = await fetch(`${baseUrl}/api/attention/items`);
    const text = await res.text();
    return {
      status: res.status,
      body: text.length > 0 ? (JSON.parse(text) as { items: AttentionInboxItem[] }) : { items: [] },
    };
  }

  async function postDismiss(body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}/api/attention/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep raw text
      }
    }
    return { status: res.status, body: parsed };
  }

  it("GET returns empty list when no session has attention", async () => {
    sessionsList.push(makeSession("clean", []));
    const res = await getItems();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [] });
  });

  it("GET aggregates one item per flag and sorts by raisedAt DESC", async () => {
    sessionsList.push(
      makeSession("alpha", [
        { kind: "needs_input", message: "a-needs", raisedAt: "2026-04-20T00:00:00.000Z" },
        { kind: "ci_failed", message: "a-ci", raisedAt: "2026-04-22T00:00:00.000Z" },
      ]),
      makeSession("beta", [
        { kind: "judge_review", message: "b-judge", raisedAt: "2026-04-21T00:00:00.000Z" },
      ]),
      makeSession("gamma", []),
    );

    const res = await getItems();
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 3);
    assert.deepEqual(
      res.body.items.map((i) => i.attention.kind),
      ["ci_failed", "judge_review", "needs_input"],
    );
    assert.deepEqual(
      res.body.items.map((i) => i.sessionSlug),
      ["alpha", "beta", "alpha"],
    );
    const ciItem = res.body.items[0]!;
    assert.equal(ciItem.sessionTitle, "Title alpha");
    assert.equal(ciItem.mode, "task");
    assert.equal(ciItem.status, "waiting_input");
  });

  it("POST dismisses the matching flag, leaves others, and emits session_updated", async () => {
    sessionsList.push(
      makeSession("s1", [
        { kind: "needs_input", message: "n", raisedAt: "2026-04-22T00:00:00.000Z" },
        { kind: "ci_failed", message: "c", raisedAt: "2026-04-21T00:00:00.000Z" },
      ]),
    );

    const res = await postDismiss({ sessionSlug: "s1", attentionKind: "needs_input" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    assert.deepEqual(dismissCalls, [{ slug: "s1", kind: "needs_input" }]);
    const remaining = sessionsList[0]!.attention.map((a) => a.kind);
    assert.deepEqual(remaining, ["ci_failed"]);
    assert.equal(busEvents.some((e) => e.kind === "session_updated"), true);
  });

  it("POST records audit with action 'attention.dismissed' and detail.attentionKind", async () => {
    sessionsList.push(
      makeSession("s2", [
        { kind: "ci_failed", message: "c", raisedAt: "2026-04-21T00:00:00.000Z" },
      ]),
    );

    const res = await postDismiss({ sessionSlug: "s2", attentionKind: "ci_failed" });
    assert.equal(res.status, 200);

    assert.equal(auditCalls.length, 1);
    const call = auditCalls[0]!;
    assert.equal(call.actor, "operator");
    assert.equal(call.action, "attention.dismissed");
    assert.deepEqual(call.target, { kind: "session", id: "s2" });
    assert.deepEqual(call.detail, { attentionKind: "ci_failed" });
  });

  it("POST returns 400 on missing sessionSlug, missing attentionKind, or invalid kind", async () => {
    const missingSlug = await postDismiss({ attentionKind: "needs_input" });
    assert.equal(missingSlug.status, 400);

    const missingKind = await postDismiss({ sessionSlug: "s3" });
    assert.equal(missingKind.status, 400);

    const invalidKind = await postDismiss({ sessionSlug: "s3", attentionKind: "not_a_real_kind" });
    assert.equal(invalidKind.status, 400);

    assert.equal(dismissCalls.length, 0);
    assert.equal(auditCalls.length, 0);
  });

  it("POST returns 404 on unknown sessionSlug", async () => {
    const res = await postDismiss({ sessionSlug: "missing", attentionKind: "needs_input" });
    assert.equal(res.status, 404);
    assert.equal(dismissCalls.length, 1);
  });

  it("POST is idempotent — dismissing a kind not present still 200s and still records audit", async () => {
    sessionsList.push(
      makeSession("s4", [
        { kind: "ci_failed", message: "c", raisedAt: "2026-04-21T00:00:00.000Z" },
      ]),
    );

    const res = await postDismiss({ sessionSlug: "s4", attentionKind: "needs_input" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });

    assert.deepEqual(dismissCalls, [{ slug: "s4", kind: "needs_input" }]);
    const remaining = sessionsList[0]!.attention.map((a) => a.kind);
    assert.deepEqual(remaining, ["ci_failed"]);
    assert.equal(busEvents.some((e) => e.kind === "session_updated"), false);

    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0]!.action, "attention.dismissed");
    assert.deepEqual(auditCalls[0]!.detail, { attentionKind: "needs_input" });
  });
});
