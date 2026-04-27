import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../context.js";
import type { Entrypoint, RegisterEntrypointRequest, EntrypointKind } from "@minions/shared";
import { EngineError } from "../../errors.js";
import { newId } from "../../util/ids.js";
import { nowIso } from "../../util/time.js";

const VALID_KINDS: EntrypointKind[] = [
  "github-webhook", "linear-webhook", "slack-event", "email", "custom",
];

interface EntrypointRow {
  id: string;
  kind: string;
  label: string;
  enabled: number;
  secret: string | null;
  config: string;
  created_at: string;
  updated_at: string;
}

function rowToEntrypoint(row: EntrypointRow): Entrypoint {
  return {
    id: row.id,
    kind: row.kind as EntrypointKind,
    label: row.label,
    enabled: row.enabled === 1,
    secret: row.secret ?? undefined,
    config: JSON.parse(row.config) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerEntrypointRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get("/api/entrypoints", async (_req, reply) => {
    const rows = ctx.db
      .prepare(`SELECT * FROM entrypoints ORDER BY created_at DESC`)
      .all() as EntrypointRow[];
    await reply.send({ items: rows.map(rowToEntrypoint) });
  });

  app.post("/api/entrypoints", async (req, reply) => {
    const body = req.body as RegisterEntrypointRequest | undefined;
    if (!body || typeof body !== "object") {
      throw new EngineError("bad_request", "Request body must be an object");
    }
    if (!VALID_KINDS.includes(body.kind as EntrypointKind)) {
      throw new EngineError("bad_request", `kind must be one of ${VALID_KINDS.join("|")}`);
    }
    if (typeof body.label !== "string" || body.label.trim() === "") {
      throw new EngineError("bad_request", "label is required");
    }

    const id = newId();
    const now = nowIso();
    ctx.db
      .prepare(
        `INSERT INTO entrypoints(id, kind, label, enabled, secret, config, created_at, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?, ?, ?)`
      )
      .run(id, body.kind, body.label, JSON.stringify(body.config ?? {}), now, now);

    const row = ctx.db.prepare(`SELECT * FROM entrypoints WHERE id = ?`).get(id) as EntrypointRow;
    await reply.status(201).send(rowToEntrypoint(row));
  });
}
