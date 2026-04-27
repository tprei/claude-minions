import type { ExternalTask, IngestExternalTaskRequest } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { newId } from "../util/ids.js";
import { registerIntakeRoutes } from "./routes.js";

export interface IntakeSubsystem {
  ingest: (req: IngestExternalTaskRequest) => Promise<ExternalTask>;
  list: () => ExternalTask[];
}

interface ExternalTaskRow {
  id: string;
  source: string;
  external_id: string;
  title: string;
  body: string;
  url: string | null;
  session_slug: string | null;
  created_at: string;
  metadata: string;
}

function rowToTask(row: ExternalTaskRow): ExternalTask {
  return {
    id: row.id,
    source: row.source as ExternalTask["source"],
    externalId: row.external_id,
    title: row.title,
    body: row.body,
    url: row.url ?? undefined,
    sessionSlug: row.session_slug ?? undefined,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export function createIntakeSubsystem(deps: SubsystemDeps): SubsystemResult<IntakeSubsystem> {
  const { db, ctx, log } = deps;

  const stmtFindBySourceId = db.prepare<[string, string], ExternalTaskRow>(
    "SELECT * FROM external_tasks WHERE source = ? AND external_id = ?",
  );
  const stmtInsert = db.prepare<[string, string, string, string, string, string | null, string | null, string, string], void>(
    `INSERT INTO external_tasks (id, source, external_id, title, body, url, session_slug, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmtUpdateSessionSlug = db.prepare<[string, string], void>(
    "UPDATE external_tasks SET session_slug = ? WHERE id = ?",
  );
  const stmtList = db.prepare<[], ExternalTaskRow>(
    "SELECT * FROM external_tasks ORDER BY created_at DESC",
  );

  async function ingest(req: IngestExternalTaskRequest): Promise<ExternalTask> {
    const existing = stmtFindBySourceId.get(req.source, req.externalId);
    if (existing) {
      log.debug("intake: idempotent hit", { source: req.source, externalId: req.externalId });
      return rowToTask(existing);
    }

    const id = newId();
    const now = new Date().toISOString();

    stmtInsert.run(
      id,
      req.source,
      req.externalId,
      req.title,
      req.body,
      req.url ?? null,
      null,
      now,
      JSON.stringify(req.metadata ?? {}),
    );

    const promptText = req.prompt
      ? req.prompt
      : [
          req.title,
          req.body ? `\n\n${req.body}` : "",
          req.url ? `\n\nSource: ${req.url}` : "",
        ].join("").trim();

    let sessionSlug: string | undefined;
    try {
      const session = await ctx.sessions.create({
        mode: req.mode ?? "task",
        prompt: promptText,
        repoId: req.repoId,
        metadata: {
          externalTaskId: id,
          externalSource: req.source,
          externalId: req.externalId,
          ...(req.metadata ?? {}),
        },
      });
      sessionSlug = session.slug;
      stmtUpdateSessionSlug.run(session.slug, id);
    } catch (err) {
      log.error("intake: failed to create session", { id, err: (err as Error).message });
    }

    const rowAfter = stmtFindBySourceId.get(req.source, req.externalId);
    if (!rowAfter) {
      return {
        id,
        source: req.source,
        externalId: req.externalId,
        title: req.title,
        body: req.body,
        url: req.url,
        sessionSlug,
        createdAt: now,
        metadata: req.metadata ?? {},
      };
    }
    return rowToTask(rowAfter);
  }

  function list(): ExternalTask[] {
    return stmtList.all().map(rowToTask);
  }

  return {
    api: { ingest, list },
    registerRoutes(app) {
      registerIntakeRoutes(app, ctx);
    },
  };
}
