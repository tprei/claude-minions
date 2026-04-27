import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mockProvider } from "./mock.js";
import type { ProviderEvent } from "./provider.js";

describe("mockProvider", () => {
  test("spawn returns a handle with expected event sequence", async () => {
    const handle = await mockProvider.spawn({
      sessionSlug: "test-slug",
      worktree: "/tmp/test",
      prompt: "do something",
      env: {},
    });

    const events: ProviderEvent[] = [];
    for await (const ev of handle) {
      events.push(ev);
    }

    assert.ok(events.length >= 4, "should emit multiple events");

    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("turn_started"), "should include turn_started");
    assert.ok(kinds.includes("assistant_text"), "should include assistant_text");
    assert.ok(kinds.includes("tool_call"), "should include tool_call");
    assert.ok(kinds.includes("tool_result"), "should include tool_result");
    assert.ok(kinds.includes("turn_completed"), "should include turn_completed");
  });

  test("first event is turn_started", async () => {
    const handle = await mockProvider.spawn({
      sessionSlug: "test-2",
      worktree: "/tmp/test2",
      prompt: "test prompt",
      env: {},
    });

    const events: ProviderEvent[] = [];
    for await (const ev of handle) {
      events.push(ev);
    }

    assert.equal(events[0]?.kind, "turn_started");
  });

  test("last event is turn_completed with success outcome", async () => {
    const handle = await mockProvider.spawn({
      sessionSlug: "test-3",
      worktree: "/tmp/test3",
      prompt: "test",
      env: {},
    });

    const events: ProviderEvent[] = [];
    for await (const ev of handle) {
      events.push(ev);
    }

    const last = events[events.length - 1];
    assert.equal(last?.kind, "turn_completed");
    if (last?.kind === "turn_completed") {
      assert.equal(last.outcome, "success");
    }
  });

  test("assistant_text includes prompt in Working on text", async () => {
    const handle = await mockProvider.spawn({
      sessionSlug: "test-4",
      worktree: "/tmp/test4",
      prompt: "my test task",
      env: {},
    });

    const events: ProviderEvent[] = [];
    for await (const ev of handle) {
      events.push(ev);
    }

    const assistantTexts = events.filter((e) => e.kind === "assistant_text");
    const firstText = assistantTexts[0];
    assert.ok(firstText?.kind === "assistant_text" && firstText.text.includes("my test task"));
  });

  test("waitForExit resolves with code 0 after iteration completes", async () => {
    const handle = await mockProvider.spawn({
      sessionSlug: "test-5",
      worktree: "/tmp/test5",
      prompt: "test",
      env: {},
    });

    for await (const _ of handle) {
    }

    const result = await handle.waitForExit();
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  });

  test("resume produces canned event sequence", async () => {
    const handle = await mockProvider.resume({
      sessionSlug: "test-6",
      worktree: "/tmp/test6",
      externalId: "ext-123",
      env: {},
    });

    const events: ProviderEvent[] = [];
    for await (const ev of handle) {
      events.push(ev);
    }

    assert.ok(events.length > 0);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("turn_completed"), "resumed session should complete");
  });

  test("kill stops iteration", async () => {
    const handle = await mockProvider.spawn({
      sessionSlug: "test-7",
      worktree: "/tmp/test7",
      prompt: "test kill",
      env: {},
    });

    const iter = handle[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.ok(!first.done, "should have first event");

    handle.kill("SIGINT");

    const result = await handle.waitForExit();
    assert.equal(result.signal, "SIGINT");
  });

  test("parseStreamChunk returns empty events", () => {
    const state = { buffer: "", turn: 0 };
    const result = mockProvider.parseStreamChunk("some data", state);
    assert.deepEqual(result.events, []);
  });

  test("detectQuotaError returns false", () => {
    assert.equal(mockProvider.detectQuotaError("rate limit exceeded"), false);
    assert.equal(mockProvider.detectQuotaError("normal text"), false);
  });
});
