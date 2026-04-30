import type { FastifyInstance } from "fastify";
import type { AttentionFlag, AttentionInboxItem } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import { EngineError } from "../../errors.js";

const ATTENTION_KINDS: ReadonlyArray<AttentionFlag["kind"]> = [
  "needs_input",
  "ci_failed",
  "ci_pending",
  "ci_passed",
  "rebase_conflict",
  "quota_exhausted",
  "judge_review",
  "manual_intervention",
  "budget_exceeded",
];

interface DismissBody {
  sessionSlug: string;
  attentionKind: AttentionFlag["kind"];
}

function parseDismissBody(raw: unknown): DismissBody {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EngineError("bad_request", "request body must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const sessionSlug = obj["sessionSlug"];
  if (typeof sessionSlug !== "string" || sessionSlug.trim().length === 0) {
    throw new EngineError("bad_request", "sessionSlug must be a non-empty string");
  }

  const attentionKind = obj["attentionKind"];
  if (typeof attentionKind !== "string" || attentionKind.trim().length === 0) {
    throw new EngineError("bad_request", "attentionKind must be a non-empty string");
  }
  if (!ATTENTION_KINDS.includes(attentionKind as AttentionFlag["kind"])) {
    throw new EngineError(
      "bad_request",
      `attentionKind must be one of ${ATTENTION_KINDS.join("|")}`,
    );
  }

  return {
    sessionSlug,
    attentionKind: attentionKind as AttentionFlag["kind"],
  };
}

export function registerAttentionRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/attention/items", async (_req, reply) => {
    const sessions = ctx.sessions.list().filter((s) => s.attention.length > 0);
    const items: AttentionInboxItem[] = [];
    for (const s of sessions) {
      for (const flag of s.attention) {
        items.push({
          sessionSlug: s.slug,
          sessionTitle: s.title,
          mode: s.mode,
          status: s.status,
          attention: flag,
        });
      }
    }
    items.sort((a, b) => b.attention.raisedAt.localeCompare(a.attention.raisedAt));
    await reply.send({ items });
  });

  app.post("/api/attention/dismiss", async (req, reply) => {
    const { sessionSlug, attentionKind } = parseDismissBody(req.body);
    ctx.sessions.dismissAttention(sessionSlug, attentionKind);
    ctx.audit.record(
      "operator",
      "attention.dismissed",
      { kind: "session", id: sessionSlug },
      { attentionKind },
    );
    await reply.send({ ok: true });
  });
}
