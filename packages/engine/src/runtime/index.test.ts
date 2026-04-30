import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { AuditEvent } from "@minions/shared";
import type { EngineContext } from "../context.js";
import { EventBus } from "../bus/eventBus.js";
import { KeyedMutex } from "../util/mutex.js";
import { runMigrations } from "../store/sqlite.js";
import { createLogger } from "../logger.js";
import { createRuntimeSubsystem } from "./index.js";
import { runtimeConfigSchema } from "./schema.js";
import type { SubsystemDeps } from "../wiring.js";

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

function makeMockCtx(audit: AuditCall[], runtime: EngineContext["runtime"]): EngineContext {
  return {
    sessions: {
      create: async () => { throw new Error("not implemented"); },
      get: () => null,
      list: () => [],
      listPaged: () => ({ items: [] }),
      listWithTranscript: () => [],
      transcript: () => [],
      stop: async () => {},
      close: async () => {},
      delete: async () => {},
      reply: async () => {},
      setDagId: () => {},
      markWaitingInput: () => {},
      kickReplyQueue: async () => false,
      resumeAllActive: async () => {},
      diff: async () => ({
        sessionSlug: "",
        patch: "",
        stats: [],
        truncated: false,
        byteSize: 0,
        generatedAt: new Date().toISOString(),
      }),
      screenshots: async () => [],
      screenshotPath: () => "",
      checkpoints: () => [],
      restoreCheckpoint: async () => {},
      updateBucket: () => {},
    },
    runtime,
    audit: {
      record: (actor, action, target, detail) => {
        audit.push({ actor, action, target, detail });
      },
      list: (): AuditEvent[] => [],
    },
    dags: {} as EngineContext["dags"],
    ship: {} as EngineContext["ship"],
    landing: {} as EngineContext["landing"],
    loops: {} as EngineContext["loops"],
    variants: {} as EngineContext["variants"],
    ci: {} as EngineContext["ci"],
    quality: {} as EngineContext["quality"],
    readiness: {} as EngineContext["readiness"],
    intake: {} as EngineContext["intake"],
    memory: {} as EngineContext["memory"],
    resource: {} as EngineContext["resource"],
    push: {} as EngineContext["push"],
    digest: {} as EngineContext["digest"],
    github: {} as EngineContext["github"],
    stats: {} as EngineContext["stats"],
    cleanup: {} as EngineContext["cleanup"],
    bus: new EventBus(),
    mutex: new KeyedMutex(),
    env: {} as EngineContext["env"],
    log: createLogger("error"),
    db: {} as EngineContext["db"],
    workspaceDir: "/tmp",
    features: () => [],
    featuresPending: () => [],
    repos: () => [],
    shutdown: async () => {},
  };
}

describe("runtime subsystem audit emission", () => {
  let db: Database.Database;
  let audit: AuditCall[];
  let ctx: EngineContext;
  let deps: SubsystemDeps;
  let api: ReturnType<typeof createRuntimeSubsystem>["api"];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, createLogger("error"));
    audit = [];
    const placeholderRuntime: EngineContext["runtime"] = {
      schema: () => runtimeConfigSchema,
      values: () => ({}),
      effective: () => ({}),
      update: async () => {},
    };
    ctx = makeMockCtx(audit, placeholderRuntime);
    deps = {
      ctx,
      log: createLogger("error"),
      env: {} as SubsystemDeps["env"],
      db,
      bus: new EventBus(),
      mutex: new KeyedMutex(),
      workspaceDir: "/tmp",
    };
    const sub = createRuntimeSubsystem(deps);
    api = sub.api;
    ctx.runtime = api;
  });

  afterEach(() => {
    db.close();
  });

  test("PATCH emits audit_event of action runtime.override with fieldPath/oldValue/newValue", async () => {
    await api.update({ ciAutoFix: true });

    const event = audit.find((e) => e.action === "runtime.override");
    assert.ok(event, "expected runtime.override audit event");
    assert.equal(event.actor, "operator");
    assert.equal(event.target?.kind, "runtime-field");
    assert.equal(event.target?.id, "ciAutoFix");
    assert.equal(event.detail?.["fieldPath"], "ciAutoFix");
    assert.equal(event.detail?.["oldValue"], false);
    assert.equal(event.detail?.["newValue"], true);
  });

  test("PATCH does not emit audit_event when value is unchanged", async () => {
    // ciAutoFix default is false; setting to false should not record anything.
    await api.update({ ciAutoFix: false });
    const event = audit.find((e) => e.action === "runtime.override");
    assert.equal(event, undefined, "no audit event should be recorded for noop update");
  });

  test("PATCH emits one audit_event per changed field", async () => {
    await api.update({ ciAutoFix: true, dagMaxConcurrent: 5 });

    const events = audit.filter((e) => e.action === "runtime.override");
    assert.equal(events.length, 2);
    const fields = events.map((e) => e.detail?.["fieldPath"]).sort();
    assert.deepEqual(fields, ["ciAutoFix", "dagMaxConcurrent"]);
  });

  test("secret-tagged fields are redacted in audit body", async () => {
    const secretFieldKey = "__test_secret_field";
    runtimeConfigSchema.fields.push({
      key: secretFieldKey,
      label: "Test Secret",
      type: "string",
      default: "initial-secret",
      secret: true,
    } as (typeof runtimeConfigSchema.fields)[number] & { secret: boolean });

    try {
      await api.update({ [secretFieldKey]: "rotated-secret" });

      const event = audit.find(
        (e) => e.action === "runtime.override" && e.detail?.["fieldPath"] === secretFieldKey,
      );
      assert.ok(event, "expected redacted audit event for secret field");
      assert.equal(event.detail?.["oldValue"], "[redacted]");
      assert.equal(event.detail?.["newValue"], "[redacted]");
      const serialized = JSON.stringify(event.detail);
      assert.ok(!serialized.includes("rotated-secret"), "secret value must not leak into detail");
      assert.ok(!serialized.includes("initial-secret"), "prior secret value must not leak into detail");
    } finally {
      const idx = runtimeConfigSchema.fields.findIndex((f) => f.key === secretFieldKey);
      if (idx >= 0) runtimeConfigSchema.fields.splice(idx, 1);
    }
  });
});
