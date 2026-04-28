import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { CreateSessionRequest, PRSummary, Session, SessionStats } from "@minions/shared";
import type { SidecarClient } from "../client.js";
import { failedCiNoFix } from "./failedCiNoFix.js";

let slugCounter = 0;
function nextSlug(): string {
  slugCounter += 1;
  return `s-${process.pid}-${Date.now()}-${slugCounter}`;
}

function emptyStats(): SessionStats {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    toolCalls: 0,
  };
}

function makePr(state: PRSummary["state"]): PRSummary {
  return {
    number: 7,
    url: "https://example.test/pr/7",
    state,
    draft: false,
    base: "main",
    head: "feature",
    title: "PR",
  };
}

function makeSession(overrides: Partial<Session> & { slug: string }): Session {
  const now = "2026-04-28T12:00:00.000Z";
  return {
    title: "session",
    prompt: "",
    mode: "task",
    status: "running",
    childSlugs: [],
    attention: [],
    quickActions: [],
    stats: emptyStats(),
    provider: "anthropic",
    createdAt: now,
    updatedAt: now,
    metadata: {},
    pr: makePr("open"),
    ...overrides,
  };
}

function failingSession(slug: string, raisedAt: string): Session {
  return makeSession({
    slug,
    attention: [{ kind: "ci_failed", message: "CI checks failed: build", raisedAt }],
  });
}

interface MockClient {
  client: SidecarClient;
  createCalls: CreateSessionRequest[];
}

interface NoopLogger {
  level: "info";
  child(): NoopLogger;
  debug(): void;
  info(): void;
  warn(): void;
  error(): void;
}

function makeClient(): MockClient {
  const createCalls: CreateSessionRequest[] = [];
  let childCounter = 0;
  const log: NoopLogger = {
    level: "info",
    child(): NoopLogger {
      return log;
    },
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
  };
  const client = {
    log,
    async getSession(slug: string): Promise<Session> {
      return makeSession({ slug });
    },
    async createSession(req: CreateSessionRequest): Promise<Session> {
      createCalls.push(req);
      childCounter += 1;
      return makeSession({ slug: `child-${childCounter}` });
    },
  } as unknown as SidecarClient;
  return { client, createCalls };
}

const handle = failedCiNoFix.onSessionUpdated;
if (!handle) throw new Error("failedCiNoFix.onSessionUpdated must be defined");

function isoOffset(baseMs: number, deltaMs: number): string {
  return new Date(baseMs + deltaMs).toISOString();
}

describe("failedCiNoFix", () => {
  test("first CI failure spawns fix-CI sub-session", async () => {
    const slug = nextSlug();
    const { client, createCalls } = makeClient();
    const now = Date.now();
    await handle(failingSession(slug, isoOffset(now, 0)), client);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]?.metadata?.["kind"], "fix-ci");
    assert.equal(createCalls[0]?.parentSlug, slug);
  });

  test("repeat failure within cooldown does not spawn again", async () => {
    const slug = nextSlug();
    const { client, createCalls } = makeClient();
    const now = Date.now();
    await handle(failingSession(slug, isoOffset(now, 0)), client);
    await handle(failingSession(slug, isoOffset(now, 60_000)), client);
    assert.equal(createCalls.length, 1);
  });

  test("repeat failure past cooldown spawns again", async () => {
    const slug = nextSlug();
    const { client, createCalls } = makeClient();
    const now = Date.now();
    await handle(failingSession(slug, isoOffset(now, 0)), client);
    await handle(failingSession(slug, isoOffset(now, 6 * 60_000)), client);
    assert.equal(createCalls.length, 2);
  });

  test("pr_state merged drops entry; later failure spawns immediately", async () => {
    const slug = nextSlug();
    const { client, createCalls } = makeClient();
    const now = Date.now();
    await handle(failingSession(slug, isoOffset(now, 0)), client);
    assert.equal(createCalls.length, 1);

    const merged = makeSession({ slug, pr: makePr("merged") });
    await handle(merged, client);

    await handle(failingSession(slug, isoOffset(now, 60_000)), client);
    assert.equal(createCalls.length, 2);
  });

  test("pr_state closed drops entry; later failure spawns immediately", async () => {
    const slug = nextSlug();
    const { client, createCalls } = makeClient();
    const now = Date.now();
    await handle(failingSession(slug, isoOffset(now, 0)), client);
    assert.equal(createCalls.length, 1);

    const closed = makeSession({ slug, pr: makePr("closed") });
    await handle(closed, client);

    await handle(failingSession(slug, isoOffset(now, 60_000)), client);
    assert.equal(createCalls.length, 2);
  });
});
