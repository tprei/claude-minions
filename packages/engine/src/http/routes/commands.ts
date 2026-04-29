import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import type {
  AttachmentInput,
  Command,
  CommandResult,
  PlanActionCommand,
  ShipStage,
} from "@minions/shared";
import { EngineError } from "../../errors.js";
import { newId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

function assertString(val: unknown, field: string): string {
  if (typeof val !== "string" || val.trim() === "") {
    throw new EngineError("bad_request", `${field} must be a non-empty string`);
  }
  return val;
}

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function validateReplyAttachments(raw: unknown, field: string): AttachmentInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new EngineError("bad_request", `${field} must be an array`);
  }
  const out: AttachmentInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!a || typeof a !== "object") {
      throw new EngineError("bad_request", `${field}[${i}] must be an object`);
    }
    const obj = a as Record<string, unknown>;
    const name = assertString(obj["name"], `${field}[${i}].name`);
    const mimeType = assertString(obj["mimeType"], `${field}[${i}].mimeType`);
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new EngineError(
        "bad_request",
        `${field}[${i}].mimeType must be one of ${[...ALLOWED_ATTACHMENT_MIME_TYPES].join(", ")}`,
      );
    }
    const url = assertString(obj["url"], `${field}[${i}].url`);
    if (!url.startsWith("/api/uploads/")) {
      throw new EngineError(
        "bad_request",
        `${field}[${i}].url must start with /api/uploads/`,
      );
    }
    if ("dataBase64" in obj) {
      throw new EngineError(
        "bad_request",
        `${field}[${i}].dataBase64 is not accepted; upload first and pass url`,
      );
    }
    out.push({ name, mimeType, url });
  }
  return out;
}

function planActionToStage(action: PlanActionCommand["action"]): ShipStage {
  switch (action) {
    case "approve":
    case "execute":
      return "dag";
    case "revise":
      return "plan";
    case "discard":
      return "think";
  }
}

function validateCommand(body: unknown): Command {
  if (!body || typeof body !== "object") {
    throw new EngineError("bad_request", "Request body must be an object");
  }
  const b = body as Record<string, unknown>;
  const kind = b["kind"];
  if (typeof kind !== "string") {
    throw new EngineError("bad_request", "Command must have a string `kind` field");
  }

  switch (kind) {
    case "reply":
      return {
        kind: "reply",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        text: assertString(b["text"], "text"),
        attachments: validateReplyAttachments(b["attachments"], "attachments"),
      };
    case "stop":
      return {
        kind: "stop",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        reason: typeof b["reason"] === "string" ? b["reason"] : undefined,
      };
    case "close":
      return {
        kind: "close",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        removeWorktree: typeof b["removeWorktree"] === "boolean" ? b["removeWorktree"] : undefined,
      };
    case "plan-action": {
      const action = b["action"];
      if (action !== "approve" && action !== "revise" && action !== "discard" && action !== "execute") {
        throw new EngineError("bad_request", "plan-action.action must be approve|revise|discard|execute");
      }
      return {
        kind: "plan-action",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        action,
        note: typeof b["note"] === "string" ? b["note"] : undefined,
      };
    }
    case "ship-advance": {
      const validStages = ["think", "plan", "dag", "verify", "done"];
      const toStage = b["toStage"];
      if (toStage !== undefined && !validStages.includes(toStage as string)) {
        throw new EngineError("bad_request", `ship-advance.toStage must be one of ${validStages.join("|")}`);
      }
      return {
        kind: "ship-advance",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        toStage: toStage as ShipStage | undefined,
        note: typeof b["note"] === "string" ? b["note"] : undefined,
      };
    }
    case "land": {
      const strategy = b["strategy"];
      if (strategy !== undefined && strategy !== "merge" && strategy !== "squash" && strategy !== "rebase") {
        throw new EngineError("bad_request", "land.strategy must be merge|squash|rebase");
      }
      return {
        kind: "land",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        strategy,
        force: typeof b["force"] === "boolean" ? b["force"] : undefined,
      };
    }
    case "retry-rebase":
      return {
        kind: "retry-rebase",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
      };
    case "submit-feedback": {
      const rating = b["rating"];
      if (rating !== "up" && rating !== "down") {
        throw new EngineError("bad_request", "submit-feedback.rating must be up|down");
      }
      return {
        kind: "submit-feedback",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        eventId: typeof b["eventId"] === "string" ? b["eventId"] : undefined,
        rating,
        reason: typeof b["reason"] === "string" ? b["reason"] : undefined,
      };
    }
    case "force": {
      const action = b["action"];
      if (action !== "release-mutex" && action !== "skip-stage" && action !== "mark-ready") {
        throw new EngineError("bad_request", "force.action must be release-mutex|skip-stage|mark-ready");
      }
      return {
        kind: "force",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        action,
      };
    }
    case "retry":
      return {
        kind: "retry",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        fromTurn: typeof b["fromTurn"] === "number" ? b["fromTurn"] : undefined,
      };
    case "judge":
      return {
        kind: "judge",
        variantParentSlug: assertString(b["variantParentSlug"], "variantParentSlug"),
        rubric: typeof b["rubric"] === "string" ? b["rubric"] : undefined,
      };
    case "split": {
      const newNodes = b["newNodes"];
      if (!Array.isArray(newNodes)) {
        throw new EngineError("bad_request", "split.newNodes must be an array");
      }
      return {
        kind: "split",
        dagId: assertString(b["dagId"], "dagId"),
        nodeId: assertString(b["nodeId"], "nodeId"),
        newNodes: newNodes as { title: string; prompt: string; dependsOn: string[] }[],
      };
    }
    case "stack": {
      const action = b["action"];
      if (action !== "show" && action !== "restack" && action !== "land-all") {
        throw new EngineError("bad_request", "stack.action must be show|restack|land-all");
      }
      return {
        kind: "stack",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
        action,
      };
    }
    case "clean":
      return {
        kind: "clean",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
      };
    case "done":
      return {
        kind: "done",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
      };
    case "dag.cancel":
      return {
        kind: "dag.cancel",
        dagId: assertString(b["dagId"], "dagId"),
      };
    case "dag.force-land":
      return {
        kind: "dag.force-land",
        dagId: assertString(b["dagId"], "dagId"),
        nodeId: assertString(b["nodeId"], "nodeId"),
      };
    case "resume-session":
      return {
        kind: "resume-session",
        sessionSlug: assertString(b["sessionSlug"], "sessionSlug"),
      };
    default:
      throw new EngineError("bad_request", `Unknown command kind: ${String(kind)}`);
  }
}

export function registerCommandRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.post("/api/commands", async (req, reply) => {
    const cmd = validateCommand(req.body);
    const result = await dispatchCommand(cmd, ctx);
    await reply.send(result);
  });
}

async function dispatchCommand(cmd: Command, ctx: EngineContext): Promise<CommandResult> {
  switch (cmd.kind) {
    case "reply":
      await ctx.sessions.reply(cmd.sessionSlug, cmd.text, cmd.attachments);
      return { ok: true };

    case "stop":
      await ctx.sessions.stop(cmd.sessionSlug, cmd.reason);
      return { ok: true };

    case "close":
      await ctx.sessions.close(cmd.sessionSlug, cmd.removeWorktree);
      return { ok: true };

    case "plan-action": {
      const stage = planActionToStage(cmd.action);
      await ctx.ship.advance(cmd.sessionSlug, stage, cmd.note);
      return { ok: true };
    }

    case "ship-advance":
      await ctx.ship.advance(cmd.sessionSlug, cmd.toStage, cmd.note);
      return { ok: true };

    case "land":
      await ctx.landing.land(cmd.sessionSlug, cmd.strategy, cmd.force);
      return { ok: true };

    case "retry-rebase":
      await ctx.landing.retryRebase(cmd.sessionSlug);
      return { ok: true };

    case "submit-feedback": {
      ctx.db
        .prepare(
          `INSERT INTO session_feedback(id, session_slug, event_id, rating, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(newId(), cmd.sessionSlug, cmd.eventId ?? null, cmd.rating, cmd.reason ?? null, nowIso());
      ctx.audit.record("operator", "submit-feedback", { kind: "session", id: cmd.sessionSlug }, {
        rating: cmd.rating,
        reason: cmd.reason,
      });
      return { ok: true };
    }

    case "force":
      if (cmd.action === "release-mutex") {
        ctx.mutex.forceRelease(cmd.sessionSlug);
      }
      ctx.audit.record("operator", `force:${cmd.action}`, { kind: "session", id: cmd.sessionSlug });
      return { ok: true };

    case "retry":
      await ctx.sessions.reply(
        cmd.sessionSlug,
        cmd.fromTurn !== undefined
          ? `Please retry from turn ${cmd.fromTurn}.`
          : "Please retry."
      );
      return { ok: true };

    case "judge":
      await ctx.variants.judge(cmd.variantParentSlug, cmd.rubric);
      return { ok: true };

    case "split": {
      const dag = await ctx.dags.splitNode({
        dagId: cmd.dagId,
        nodeId: cmd.nodeId,
        newNodes: cmd.newNodes,
      });
      return { ok: true, data: dag };
    }

    case "stack": {
      ctx.audit.record("operator", `stack:${cmd.action}`, { kind: "session", id: cmd.sessionSlug });
      const session = ctx.sessions.get(cmd.sessionSlug);
      return { ok: true, data: { stack: session ? { slug: session.slug, branch: session.branch } : null } };
    }

    case "clean":
      await ctx.sessions.close(cmd.sessionSlug, true);
      return { ok: true };

    case "done":
      await ctx.sessions.stop(cmd.sessionSlug);
      await ctx.landing.land(cmd.sessionSlug);
      return { ok: true };

    case "dag.cancel":
      await ctx.dags.cancel(cmd.dagId);
      return { ok: true };

    case "dag.force-land":
      await ctx.dags.forceLand(cmd.dagId, cmd.nodeId);
      return { ok: true };

    case "resume-session": {
      const kicked = await ctx.sessions.kickReplyQueue(cmd.sessionSlug);
      return { ok: true, data: { kicked } };
    }
  }
}
