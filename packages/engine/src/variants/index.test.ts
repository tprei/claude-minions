import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CreateSessionRequest,
  CreateVariantsRequest,
  Session,
} from "@minions/shared";
import { EventBus } from "../bus/eventBus.js";
import { createLogger } from "../logger.js";
import type { EngineContext } from "../context.js";
import { createVariantsSubsystem } from "./index.js";

interface Harness {
  taskCreates: CreateSessionRequest[];
  reviewCreates: CreateSessionRequest[];
  judgeDone: Promise<void>;
  bus: EventBus;
  spawn: (req: CreateVariantsRequest) => Promise<{ parentSlug: string; childSlugs: string[] }>;
}

function buildHarness(): Harness {
  const bus = new EventBus();
  const log = createLogger("error");
  const taskCreates: CreateSessionRequest[] = [];
  const reviewCreates: CreateSessionRequest[] = [];
  let judgeResolve: () => void = () => {};
  const judgeDone = new Promise<void>((resolve) => {
    judgeResolve = resolve;
  });

  let nextChildIdx = 0;
  const fakeSession = (slug: string): Session =>
    ({
      slug,
      title: slug,
      prompt: "",
      mode: "task",
      status: "running",
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
      provider: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    }) as Session;

  const ctx = {
    sessions: {
      create: async (req: CreateSessionRequest): Promise<Session> => {
        if (req.mode === "review") {
          reviewCreates.push(req);
          throw new Error("review create disabled in test");
        }
        taskCreates.push(req);
        const slug = req.metadata?.["variantParent"]
          ? "parent"
          : `child-${nextChildIdx++}`;
        return fakeSession(slug);
      },
      reply: async () => {
        judgeResolve();
      },
      list: () => [],
      transcript: () => [],
    },
    bus,
  } as unknown as EngineContext;

  const subsystem = createVariantsSubsystem({
    ctx,
    log,
    bus,
    env: {} as never,
    db: {} as never,
    mutex: {} as never,
    workspaceDir: "/tmp",
  });

  return {
    taskCreates,
    reviewCreates,
    judgeDone,
    bus,
    spawn: subsystem.api.spawn,
  };
}

function emitCompletions(bus: EventBus, slugs: string[]): void {
  for (const slug of slugs) {
    bus.emit({
      kind: "session_updated",
      session: { slug, status: "completed" } as Session,
    });
  }
}

describe("createVariantsSubsystem.spawn — count is total worker sessions", () => {
  it("count=1 spawns exactly 1 worker (parent solo, no children)", async () => {
    const h = buildHarness();
    const result = await h.spawn({ prompt: "x", count: 1, judgeRubric: "r" });

    assert.equal(h.taskCreates.length, 1, "exactly 1 task session created");
    assert.equal(result.childSlugs.length, 0, "no children for count=1");
    assert.equal(
      1 + result.childSlugs.length,
      1,
      "total workers = parent + children = 1",
    );
  });

  it("count=3 spawns exactly 3 workers (parent + 2 children, not 4)", async () => {
    const h = buildHarness();
    const result = await h.spawn({ prompt: "x", count: 3, judgeRubric: "r" });

    assert.equal(h.taskCreates.length, 3, "exactly 3 task sessions created");
    assert.equal(result.childSlugs.length, 2, "2 children for count=3");
    assert.equal(
      1 + result.childSlugs.length,
      3,
      "total workers = parent + children = 3",
    );

    emitCompletions(h.bus, result.childSlugs);
    await h.judgeDone;
  });

  it("count=5 spawns exactly 5 workers (parent + 4 children)", async () => {
    const h = buildHarness();
    const result = await h.spawn({ prompt: "x", count: 5, judgeRubric: "r" });

    assert.equal(h.taskCreates.length, 5, "exactly 5 task sessions created");
    assert.equal(result.childSlugs.length, 4, "4 children for count=5");
    assert.equal(
      1 + result.childSlugs.length,
      5,
      "total workers = parent + children = 5",
    );

    emitCompletions(h.bus, result.childSlugs);
    await h.judgeDone;
  });

  it("count clamps to 10 (parent + 9 children = 10 workers)", async () => {
    const h = buildHarness();
    const result = await h.spawn({ prompt: "x", count: 99, judgeRubric: "r" });

    assert.equal(h.taskCreates.length, 10, "clamped to 10 task sessions");
    assert.equal(result.childSlugs.length, 9);

    emitCompletions(h.bus, result.childSlugs);
    await h.judgeDone;
  });

  it("count clamps to 1 minimum (count=0 → 1 worker, no children)", async () => {
    const h = buildHarness();
    const result = await h.spawn({ prompt: "x", count: 0, judgeRubric: "r" });

    assert.equal(h.taskCreates.length, 1, "clamped to 1 task session");
    assert.equal(result.childSlugs.length, 0);
  });
});
