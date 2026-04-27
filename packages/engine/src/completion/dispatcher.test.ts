import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../bus/eventBus.js";
import { CompletionDispatcher } from "./dispatcher.js";
import { createLogger } from "../logger.js";
import type { Session, SessionStatus } from "@minions/shared";

function makeSession(slug: string, status: SessionStatus): Session {
  return {
    slug,
    title: "test",
    prompt: "p",
    mode: "task",
    status,
    childSlugs: [],
    attention: [],
    quickActions: [],
    stats: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
    provider: "mock",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    metadata: {},
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("CompletionDispatcher", () => {
  test("fires each registered handler exactly once on terminal status", async () => {
    const bus = new EventBus();
    const dispatcher = new CompletionDispatcher(bus, createLogger("error"));

    let aCalls = 0;
    let bCalls = 0;
    let cCalls = 0;
    const handlerA = async (): Promise<void> => {
      aCalls += 1;
    };
    const handlerB = async (): Promise<void> => {
      bCalls += 1;
    };
    const handlerC = async (): Promise<void> => {
      cCalls += 1;
    };

    dispatcher.register(handlerA);
    dispatcher.register(handlerB);
    dispatcher.register(handlerC);
    const unsubscribe = dispatcher.wire();

    bus.emit({ kind: "session_updated", session: makeSession("s1", "completed") });
    await flush();

    assert.equal(aCalls, 1);
    assert.equal(bCalls, 1);
    assert.equal(cCalls, 1);

    unsubscribe();
  });

  test("does not re-fire when same slug is already terminal", async () => {
    const bus = new EventBus();
    const dispatcher = new CompletionDispatcher(bus, createLogger("error"));

    let count = 0;
    dispatcher.register(async () => {
      count += 1;
    });
    const unsubscribe = dispatcher.wire();

    bus.emit({ kind: "session_updated", session: makeSession("s1", "completed") });
    await flush();
    bus.emit({ kind: "session_updated", session: makeSession("s1", "failed") });
    await flush();

    assert.equal(count, 1);

    unsubscribe();
  });

  test("does not fire for non-terminal status", async () => {
    const bus = new EventBus();
    const dispatcher = new CompletionDispatcher(bus, createLogger("error"));

    let count = 0;
    dispatcher.register(async () => {
      count += 1;
    });
    const unsubscribe = dispatcher.wire();

    bus.emit({ kind: "session_updated", session: makeSession("s1", "running") });
    await flush();

    assert.equal(count, 0);

    unsubscribe();
  });
});
