import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createAuditSubsystem } from "./index.js";
import type { SubsystemDeps } from "../wiring.js";

function makeDeps(db: Database.Database, workspaceDir: string): SubsystemDeps {
  const log = createLogger("error");
  return {
    ctx: {} as SubsystemDeps["ctx"],
    log,
    env: {} as SubsystemDeps["env"],
    db,
    bus: new EventBus(),
    mutex: new KeyedMutex(),
    workspaceDir,
  };
}

describe("createAuditSubsystem", () => {
  let db: Database.Database;
  let workspaceDir: string;

  before(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, createLogger("error"));
  });

  after(async () => {
    db.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  test("record then list returns the event", async () => {
    const { api: audit } = createAuditSubsystem(makeDeps(db, workspaceDir));

    audit.record("operator", "test-action", { kind: "session", id: "sess-1" }, { extra: true });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = audit.list(10);
    assert.ok(events.length >= 1);

    const event = events.find((e) => e.action === "test-action");
    assert.ok(event, "should find the recorded event");
    assert.equal(event.actor, "operator");
    assert.equal(event.action, "test-action");
    assert.deepEqual(event.target, { kind: "session", id: "sess-1" });
    assert.deepEqual(event.detail, { extra: true });
    assert.ok(event.id);
    assert.ok(event.timestamp);
  });

  test("list respects limit", () => {
    const { api: audit } = createAuditSubsystem(makeDeps(db, workspaceDir));

    for (let i = 0; i < 5; i++) {
      audit.record("system", `action-limit-${i}`);
    }

    const limited = audit.list(3);
    assert.ok(limited.length <= 3);
  });

  test("record without target and detail", () => {
    const { api: audit } = createAuditSubsystem(makeDeps(db, workspaceDir));

    audit.record("system", "bare-action-test");

    const events = audit.list(10);
    const event = events.find((e) => e.action === "bare-action-test");
    assert.ok(event);
    assert.equal(event.target, undefined);
    assert.equal(event.detail, undefined);
  });

  test("appends to audit.log JSONL file", async () => {
    const { api: audit } = createAuditSubsystem(makeDeps(db, workspaceDir));

    audit.record("operator", "logged-action-test");

    await new Promise((resolve) => setTimeout(resolve, 50));

    const logPath = path.join(workspaceDir, "audit", "audit.log");
    const content = await fs.readFile(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    assert.ok(lines.length >= 1);

    const parsed = JSON.parse(lines[lines.length - 1]!) as { action: string };
    assert.ok(parsed.action);
  });
});
