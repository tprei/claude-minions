import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  CleanupCandidate,
  CleanupCandidatesResponse,
  CleanupExecuteRequest,
  CleanupExecuteResponse,
  DAG,
  RuntimeOverrides,
  Session,
} from "@minions/shared";
import type { EngineContext } from "../context.js";
import type { Logger } from "../logger.js";
import {
  makeCleanupCron,
  msUntilNextLocalHour,
  type CleanupCronDeps,
} from "./cron.js";

function makeLogger(): Logger {
  const noop = () => {};
  const log: Logger = {
    level: "info",
    child: () => log,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return log;
}

function makeSession(slug: string, overrides: Partial<Session> = {}): Session {
  return {
    slug,
    title: slug,
    prompt: "",
    mode: "task",
    status: "completed",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function makeCandidate(slug: string): CleanupCandidate {
  return {
    slug,
    title: slug,
    status: "completed",
    completedAt: null,
    worktreePath: null,
    branch: null,
  };
}

interface AuditCall {
  actor: string;
  action: string;
  target?: { kind: string; id: string };
  detail?: Record<string, unknown>;
}

interface HarnessOpts {
  candidates?: CleanupCandidate[];
  sessionsMap?: Map<string, Session>;
  dagsMap?: Map<string, DAG>;
  effective?: RuntimeOverrides;
  executeImpl?: (req: CleanupExecuteRequest) => Promise<CleanupExecuteResponse>;
  selectCandidatesImpl?: (opts: {
    statuses: ("completed" | "failed" | "cancelled")[];
    olderThanDays: number;
    limit: number;
  }) => Promise<CleanupCandidatesResponse>;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  setIntervalFn?: typeof setInterval;
}

interface Harness {
  deps: CleanupCronDeps;
  audit: AuditCall[];
  selectCandidatesCalls: { statuses: string[]; olderThanDays: number; limit: number }[];
  executeCalls: CleanupExecuteRequest[];
  dagsGetCalls: string[];
}

function buildHarness(opts: HarnessOpts = {}): Harness {
  const audit: AuditCall[] = [];
  const selectCandidatesCalls: Harness["selectCandidatesCalls"] = [];
  const executeCalls: CleanupExecuteRequest[] = [];
  const dagsGetCalls: string[] = [];

  const sessionsMap = opts.sessionsMap ?? new Map<string, Session>();
  const dagsMap = opts.dagsMap ?? new Map<string, DAG>();
  const candidates = opts.candidates ?? [];

  const cleanup = {
    selectCandidates: async (o: {
      statuses: ("completed" | "failed" | "cancelled")[];
      olderThanDays: number;
      limit: number;
    }): Promise<CleanupCandidatesResponse> => {
      selectCandidatesCalls.push({ statuses: [...o.statuses], olderThanDays: o.olderThanDays, limit: o.limit });
      if (opts.selectCandidatesImpl) return opts.selectCandidatesImpl(o);
      return { items: candidates, nextCursor: null };
    },
    preview: async () => ({ count: 0, totalBytes: 0, ineligible: [] }),
    execute: async (req: CleanupExecuteRequest): Promise<CleanupExecuteResponse> => {
      executeCalls.push({ slugs: [...req.slugs], removeWorktree: req.removeWorktree });
      if (opts.executeImpl) return opts.executeImpl(req);
      return { deleted: req.slugs.length, bytesReclaimed: 0, errors: [] };
    },
  } satisfies EngineContext["cleanup"];

  const sessions = {
    get: (slug: string) => sessionsMap.get(slug) ?? null,
  } as unknown as EngineContext["sessions"];

  const dags = {
    get: (id: string) => {
      dagsGetCalls.push(id);
      return dagsMap.get(id) ?? null;
    },
  } as unknown as EngineContext["dags"];

  const runtime = {
    schema: () => ({ groups: [], fields: [] }),
    values: () => ({}),
    effective: () => opts.effective ?? { autoCleanupEnabled: true, cleanupOlderThanDays: 7, cleanupHourLocal: 3 },
    update: async () => {},
  } satisfies EngineContext["runtime"];

  const auditFns = {
    record: (
      actor: string,
      action: string,
      target?: { kind: string; id: string },
      detail?: Record<string, unknown>,
    ) => {
      audit.push({ actor, action, target, detail });
    },
    list: () => [],
  } satisfies EngineContext["audit"];

  const deps: CleanupCronDeps = {
    cleanup,
    sessions,
    dags,
    runtime,
    audit: auditFns,
    log: makeLogger(),
    now: opts.now,
    setTimeoutFn: opts.setTimeoutFn,
    setIntervalFn: opts.setIntervalFn,
  };

  return { deps, audit, selectCandidatesCalls, executeCalls, dagsGetCalls };
}

test("warmup gate skips tick within first hour", async () => {
  const T0 = 1_700_000_000_000;
  let nowVal = T0;
  const noopTimeout = ((_cb: () => void, _ms: number) =>
    ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout;
  const h = buildHarness({
    candidates: [makeCandidate("s1")],
    now: () => nowVal,
    setTimeoutFn: noopTimeout,
  });
  const cron = makeCleanupCron(h.deps);
  cron.start();
  nowVal = T0 + 30 * 60 * 1000;

  const summary = await cron.tickForTest();

  assert.equal(summary.skipped, "warmup");
  assert.equal(summary.checked, 0);
  assert.equal(summary.deleted, 0);
  assert.equal(h.executeCalls.length, 0);
  assert.equal(h.audit.length, 0);
});

test("disabled flag short-circuits without execute or audit", async () => {
  const h = buildHarness({
    effective: { autoCleanupEnabled: false },
    candidates: [makeCandidate("s1")],
  });
  const cron = makeCleanupCron(h.deps);

  const summary = await cron.tickForTest();

  assert.equal(summary.skipped, "disabled");
  assert.equal(h.executeCalls.length, 0);
  assert.equal(h.audit.length, 0);
});

test("excludes sessions with open PR", async () => {
  const sessionsMap = new Map<string, Session>([
    ["a", makeSession("a", { pr: { number: 1, url: "u", state: "open", draft: false, base: "main", head: "h", title: "t" } })],
    ["b", makeSession("b")],
    ["c", makeSession("c")],
  ]);
  const h = buildHarness({
    candidates: [makeCandidate("a"), makeCandidate("b"), makeCandidate("c")],
    sessionsMap,
  });
  const cron = makeCleanupCron(h.deps);

  const summary = await cron.tickForTest();

  assert.equal(h.executeCalls.length, 1);
  assert.deepEqual(h.executeCalls[0]!.slugs.sort(), ["b", "c"]);
  assert.equal(h.executeCalls[0]!.removeWorktree, true);
  assert.equal(summary.checked, 3);
});

test("excludes sessions in active DAGs and dedupes dag lookups", async () => {
  const sessionsMap = new Map<string, Session>([
    ["a", makeSession("a", { dagId: "d1" })],
    ["b", makeSession("b", { dagId: "d1" })],
    ["c", makeSession("c")],
  ]);
  const dagsMap = new Map<string, DAG>([
    [
      "d1",
      {
        id: "d1",
        title: "d1",
        goal: "g",
        nodes: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        metadata: {},
      },
    ],
  ]);
  const h = buildHarness({
    candidates: [makeCandidate("a"), makeCandidate("b"), makeCandidate("c")],
    sessionsMap,
    dagsMap,
  });
  const cron = makeCleanupCron(h.deps);

  await cron.tickForTest();

  assert.equal(h.executeCalls.length, 1);
  assert.deepEqual(h.executeCalls[0]!.slugs, ["c"]);
  assert.equal(h.dagsGetCalls.filter((id) => id === "d1").length, 1);
});

test("selectCandidates is called with limit=100 and the cleanup statuses", async () => {
  const h = buildHarness();
  const cron = makeCleanupCron(h.deps);

  await cron.tickForTest();

  assert.equal(h.selectCandidatesCalls.length, 1);
  assert.equal(h.selectCandidatesCalls[0]!.limit, 100);
  assert.deepEqual(h.selectCandidatesCalls[0]!.statuses, ["completed", "failed", "cancelled"]);
  assert.equal(h.selectCandidatesCalls[0]!.olderThanDays, 7);
});

test("execute throwing surfaces as internal error and tick resolves", async () => {
  const sessionsMap = new Map<string, Session>([["a", makeSession("a")]]);
  const h = buildHarness({
    candidates: [makeCandidate("a")],
    sessionsMap,
    executeImpl: async () => {
      throw new Error("boom");
    },
  });
  const cron = makeCleanupCron(h.deps);

  const summary = await cron.tickForTest();

  assert.equal(summary.deleted, 0);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0]!.slug, "*");
  assert.equal(summary.errors[0]!.code, "internal");
  assert.match(summary.errors[0]!.message, /boom/);
  assert.equal(h.audit.length, 1);
});

test("audit.record is called once with the expected shape", async () => {
  const sessionsMap = new Map<string, Session>([["a", makeSession("a")]]);
  const h = buildHarness({
    candidates: [makeCandidate("a")],
    sessionsMap,
  });
  const cron = makeCleanupCron(h.deps);

  await cron.tickForTest();

  assert.equal(h.audit.length, 1);
  const call = h.audit[0]!;
  assert.equal(call.actor, "system");
  assert.equal(call.action, "cleanup.cron.tick");
  assert.equal(call.target, undefined);
  assert.ok(call.detail, "detail must be present");
  assert.deepEqual(Object.keys(call.detail!).sort(), ["bytesReclaimed", "checked", "deleted", "errors"]);
  assert.equal(call.detail!.checked, 1);
  assert.equal(call.detail!.deleted, 1);
});

test("stop clears interval timer and awaits in-flight tick", async () => {
  let timeoutCb: (() => void) | null = null;
  let intervalCb: (() => void) | null = null;
  const timeoutHandle = { kind: "fake-timeout", unref: () => {} };
  const intervalHandle = { kind: "fake-interval", unref: () => {} };
  const fakeSetTimeout = ((cb: () => void) => {
    timeoutCb = cb;
    return timeoutHandle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const fakeSetInterval = ((cb: () => void) => {
    intervalCb = cb;
    return intervalHandle as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  const cleared: { kind: string; handle: unknown }[] = [];
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;
  globalThis.clearTimeout = ((h: unknown) => {
    cleared.push({ kind: "timeout", handle: h });
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((h: unknown) => {
    cleared.push({ kind: "interval", handle: h });
  }) as typeof clearInterval;

  try {
    let executeResolve: (v: CleanupExecuteResponse) => void = () => {};
    const executePromise = new Promise<CleanupExecuteResponse>((resolve) => {
      executeResolve = resolve;
    });

    const T0 = 1_700_000_000_000;
    let nowVal = T0;
    const sessionsMap = new Map<string, Session>([["a", makeSession("a")]]);
    const h = buildHarness({
      candidates: [makeCandidate("a")],
      sessionsMap,
      executeImpl: () => executePromise,
      now: () => nowVal,
      setTimeoutFn: fakeSetTimeout,
      setIntervalFn: fakeSetInterval,
    });
    const cron = makeCleanupCron(h.deps);

    cron.start();
    nowVal = T0 + 2 * 60 * 60 * 1000;

    assert.ok(timeoutCb, "timeout callback must be captured");
    (timeoutCb as unknown as () => void)();

    assert.ok(intervalCb, "interval callback must be captured after timeout fires");

    let stopResolved = false;
    const stopP = cron.stop().then(() => {
      stopResolved = true;
    });

    await new Promise((r) => setImmediate(r));
    assert.equal(stopResolved, false, "stop must wait on in-flight tick");

    assert.ok(
      cleared.some((c) => c.kind === "interval" && c.handle === intervalHandle),
      "stop must clear interval handle",
    );

    executeResolve({ deleted: 1, bytesReclaimed: 0, errors: [] });
    await stopP;
    assert.equal(stopResolved, true);
  } finally {
    globalThis.clearTimeout = origClearTimeout;
    globalThis.clearInterval = origClearInterval;
  }
});

test("stop clears initial timer when called before first fire", async () => {
  let timeoutCb: (() => void) | null = null;
  const timeoutHandle = { kind: "fake-timeout", unref: () => {} };
  const fakeSetTimeout = ((cb: () => void) => {
    timeoutCb = cb;
    return timeoutHandle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const fakeSetInterval = (() =>
    ({ unref: () => {} }) as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

  const cleared: { kind: string; handle: unknown }[] = [];
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;
  globalThis.clearTimeout = ((h: unknown) => {
    cleared.push({ kind: "timeout", handle: h });
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((h: unknown) => {
    cleared.push({ kind: "interval", handle: h });
  }) as typeof clearInterval;

  try {
    const h = buildHarness({
      setTimeoutFn: fakeSetTimeout,
      setIntervalFn: fakeSetInterval,
    });
    const cron = makeCleanupCron(h.deps);
    cron.start();

    assert.ok(timeoutCb, "timeout callback should be scheduled");

    await cron.stop();

    assert.ok(
      cleared.some((c) => c.kind === "timeout" && c.handle === timeoutHandle),
      "stop must clear initial timeout handle when called before fire",
    );
  } finally {
    globalThis.clearTimeout = origClearTimeout;
    globalThis.clearInterval = origClearInterval;
  }
});

test("msUntilNextLocalHour returns time-to-next when target is later today", () => {
  const now = new Date(2026, 4, 1, 2, 30, 0, 0).getTime();
  const ms = msUntilNextLocalHour(3, now);
  assert.equal(ms, 30 * 60 * 1000);
});

test("msUntilNextLocalHour rolls to tomorrow when target is past or equal", () => {
  const now = new Date(2026, 4, 1, 4, 0, 0, 0).getTime();
  const ms = msUntilNextLocalHour(3, now);
  assert.equal(ms, 23 * 60 * 60 * 1000);

  const equalNow = new Date(2026, 4, 1, 3, 0, 0, 0).getTime();
  const equalMs = msUntilNextLocalHour(3, equalNow);
  assert.equal(equalMs, 24 * 60 * 60 * 1000);
});
