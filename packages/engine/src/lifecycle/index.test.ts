import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { createLifecycleSubsystem } from "./index.js";
import type { SubsystemDeps } from "../wiring.js";
import type { EngineContext } from "../context.js";

interface PushCall {
  sessionSlug: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface PushStub {
  calls: PushCall[];
  shouldThrow: boolean;
}

function makePushStub(): PushStub {
  return { calls: [], shouldThrow: false };
}

function makeDeps(db: Database.Database, pushStub: PushStub): SubsystemDeps {
  const log = createLogger("error");
  const ctx = {
    push: {
      vapidPublicKey: () => null,
      async subscribe() {},
      async unsubscribe() {},
      async notify(sessionSlug: string, title: string, body: string, data?: Record<string, unknown>) {
        pushStub.calls.push({ sessionSlug, title, body, data });
        if (pushStub.shouldThrow) throw new Error("push failed");
      },
    },
  } as unknown as EngineContext;

  return {
    ctx,
    log,
    env: {} as SubsystemDeps["env"],
    db,
    bus: new EventBus(),
    mutex: new KeyedMutex(),
    workspaceDir: "/tmp/lifecycle-test",
  };
}

describe("createLifecycleSubsystem", () => {
  let db: Database.Database;
  let pushStub: PushStub;

  before(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, createLogger("error"));
  });

  after(() => {
    db.close();
  });

  beforeEach(() => {
    db.exec("DELETE FROM engine_lifecycle_events");
    pushStub = makePushStub();
  });

  test("record writes a row and invokes push.notify with derived title and matching body", async () => {
    const { api: lifecycle } = createLifecycleSubsystem(makeDeps(db, pushStub));

    await lifecycle.record({
      eventType: "engine.crashed",
      severity: "error",
      message: "uncaught exception",
      detail: { reason: "boom" },
    });

    const { items } = lifecycle.list();
    assert.equal(items.length, 1);
    const row = items[0]!;
    assert.equal(row.eventType, "engine.crashed");
    assert.equal(row.severity, "error");
    assert.equal(row.message, "uncaught exception");
    assert.deepEqual(row.detail, { reason: "boom" });
    assert.ok(row.id);
    assert.ok(row.timestamp);

    assert.equal(pushStub.calls.length, 1);
    const call = pushStub.calls[0]!;
    assert.equal(call.sessionSlug, "");
    assert.equal(call.title, "Engine crashed");
    assert.equal(call.body, "uncaught exception");
    assert.deepEqual(call.data, { eventType: "engine.crashed", reason: "boom" });
  });

  test("list returns newest-first", async () => {
    const { api: lifecycle } = createLifecycleSubsystem(makeDeps(db, pushStub));

    await lifecycle.record({ eventType: "engine.started", severity: "info", message: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await lifecycle.record({ eventType: "engine.started", severity: "info", message: "second" });
    await new Promise((r) => setTimeout(r, 5));
    await lifecycle.record({ eventType: "engine.started", severity: "info", message: "third" });

    const { items } = lifecycle.list();
    assert.equal(items.length, 3);
    assert.equal(items[0]!.message, "third");
    assert.equal(items[1]!.message, "second");
    assert.equal(items[2]!.message, "first");
  });

  test("cursor pagination via beforeTs returns the right slice", async () => {
    const { api: lifecycle } = createLifecycleSubsystem(makeDeps(db, pushStub));

    for (let i = 0; i < 5; i++) {
      await lifecycle.record({
        eventType: "resource.alert",
        severity: "warn",
        message: `alert ${i}`,
      });
      await new Promise((r) => setTimeout(r, 5));
    }

    const firstPage = lifecycle.list(2);
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.items[0]!.message, "alert 4");
    assert.equal(firstPage.items[1]!.message, "alert 3");
    assert.ok(firstPage.nextCursor);

    const secondPage = lifecycle.list(2, firstPage.nextCursor);
    assert.equal(secondPage.items.length, 2);
    assert.equal(secondPage.items[0]!.message, "alert 2");
    assert.equal(secondPage.items[1]!.message, "alert 1");
    assert.ok(secondPage.nextCursor);

    const thirdPage = lifecycle.list(2, secondPage.nextCursor);
    assert.equal(thirdPage.items.length, 1);
    assert.equal(thirdPage.items[0]!.message, "alert 0");
    assert.equal(thirdPage.nextCursor, undefined);
  });

  test("push.notify throwing does not prevent the row write", async () => {
    pushStub = makePushStub();
    pushStub.shouldThrow = true;
    const { api: lifecycle } = createLifecycleSubsystem(makeDeps(db, pushStub));

    await lifecycle.record({
      eventType: "ci.exhausted",
      severity: "warn",
      message: "ci budget exhausted",
    });

    const { items } = lifecycle.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.message, "ci budget exhausted");
    assert.equal(pushStub.calls.length, 1);
  });
});
