import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { migrations } from "./migrations.js";

export interface OpenStoreOptions {
  path: string;
  log: Logger;
  readonly?: boolean;
}

export function openStore(opts: OpenStoreOptions): Database.Database {
  fs.mkdirSync(path.dirname(opts.path), { recursive: true });
  const db = new Database(opts.path, { readonly: !!opts.readonly });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  if (!opts.readonly) {
    runMigrations(db, opts.log);
  }
  return db;
}

export function runMigrations(db: Database.Database, log: Logger): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  ) WITHOUT ROWID`);

  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name),
  );

  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) {
    log.debug("schema up to date", { count: migrations.length });
    return;
  }

  const tx = db.transaction((items: typeof migrations) => {
    for (const m of items) {
      log.info("applying migration", { name: m.name });
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)").run(m.name, new Date().toISOString());
    }
  });
  tx(pending);
  log.info("migrations applied", { count: pending.length });
}
