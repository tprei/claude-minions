import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestEngine } from "./engine.js";

test("createTestEngine boots a working in-process engine on an OS-allocated port", async () => {
  const engine = await createTestEngine();
  try {
    assert.notEqual(engine.ctx.env.port, 0, "OS-allocated port should be captured");
    assert.match(engine.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(engine.token.startsWith("test-"));

    assert.ok(engine.ctx.sessions, "sessions subsystem present");
    assert.ok(engine.ctx.dags, "dags subsystem present");
    assert.ok(engine.ctx.ship, "ship subsystem present");
    assert.ok(engine.ctx.loops, "loops subsystem present");

    const res = await fetch(`${engine.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await engine.close();
  }

  const res = await fetch(`${engine.baseUrl}/api/health`).catch((e: unknown) => e);
  assert.ok(res instanceof Error, "server should refuse connections after close");
});

test("createTestEngine respects opts overrides", async () => {
  const engine = await createTestEngine({ token: "custom-token" });
  try {
    assert.equal(engine.ctx.env.token, "custom-token");
    assert.equal(engine.token, "custom-token", "fixture token should reflect override");
  } finally {
    await engine.close();
  }
});
