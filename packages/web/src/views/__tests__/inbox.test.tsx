import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AttentionFlag,
  AttentionInboxItem,
  ListEnvelope,
  OkEnvelope,
  Session,
} from "@minions/shared";
import { useConnectionStore } from "../../connections/store.js";
import { useSessionStore } from "../../store/sessionStore.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getAttentionItemsMock = vi.fn<[unknown], Promise<ListEnvelope<AttentionInboxItem>>>();
const dismissAttentionMock =
  vi.fn<[unknown, string, AttentionFlag["kind"]], Promise<OkEnvelope>>();
const setUrlStateMock = vi.fn();

vi.mock("../../transport/rest.js", () => ({
  getAttentionItems: (conn: unknown) => getAttentionItemsMock(conn),
  dismissAttention: (conn: unknown, slug: string, kind: AttentionFlag["kind"]) =>
    dismissAttentionMock(conn, slug, kind),
}));

vi.mock("../../routing/urlState.js", () => ({
  setUrlState: (...args: unknown[]) => setUrlStateMock(...args),
}));

const { InboxView } = await import("../inbox.js");

const TEST_CONN = {
  id: "conn-1",
  label: "Test",
  baseUrl: "http://localhost:9999",
  token: "tok",
  color: "#7c5cff",
};

const API = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

function setActiveConnection(): void {
  useConnectionStore.setState({
    connections: [TEST_CONN],
    activeId: TEST_CONN.id,
    _hydrated: true,
  });
}

function clearStores(): void {
  useConnectionStore.setState({ connections: [], activeId: null, _hydrated: true });
  useSessionStore.setState({ byConnection: new Map() });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    slug: "sess",
    title: "Session",
    prompt: "p",
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
    ...overrides,
  };
}

function flag(
  kind: AttentionFlag["kind"],
  raisedAt: string,
  message = "needs attention",
): AttentionFlag {
  return { kind, message, raisedAt };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  getAttentionItemsMock.mockReset();
  dismissAttentionMock.mockReset();
  setUrlStateMock.mockReset();
  getAttentionItemsMock.mockResolvedValue({ items: [] });
  setActiveConnection();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  clearStores();
});

describe("InboxView", () => {
  it("renders one row per attention item across multiple sessions", async () => {
    const s1 = makeSession({
      slug: "alpha",
      title: "Alpha session",
      attention: [flag("needs_input", "2026-04-30T10:00:00Z", "needs your reply")],
    });
    const s2 = makeSession({
      slug: "beta",
      title: "Beta session",
      attention: [
        flag("ci_failed", "2026-04-30T09:00:00Z", "tests red"),
        flag("rebase_conflict", "2026-04-30T08:00:00Z", "merge conflict"),
      ],
    });
    useSessionStore.getState().replaceAll(TEST_CONN.id, [s1, s2]);

    await act(async () => {
      root.render(createElement(InboxView, { api: API }));
    });
    await flush();

    expect(container.querySelector('[data-testid="inbox-row-alpha-needs_input"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inbox-row-beta-ci_failed"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="inbox-row-beta-rebase_conflict"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="inbox-row-"]').length).toBe(3);
  });

  it("groups rows by attention.kind under the configured group order", async () => {
    const s1 = makeSession({
      slug: "alpha",
      title: "Alpha",
      attention: [flag("ci_failed", "2026-04-30T09:00:00Z")],
    });
    const s2 = makeSession({
      slug: "beta",
      title: "Beta",
      attention: [flag("needs_input", "2026-04-30T08:00:00Z")],
    });
    const s3 = makeSession({
      slug: "gamma",
      title: "Gamma",
      attention: [flag("ci_passed", "2026-04-30T07:00:00Z")],
    });
    useSessionStore.getState().replaceAll(TEST_CONN.id, [s1, s2, s3]);

    await act(async () => {
      root.render(createElement(InboxView, { api: API }));
    });
    await flush();

    const groups = Array.from(
      container.querySelectorAll('[data-testid^="inbox-group-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(groups).toEqual([
      "inbox-group-needs_input",
      "inbox-group-ci_failed",
      "inbox-group-ci_passed",
    ]);
  });

  it("clicking the title button calls setUrlState with the right slug", async () => {
    const s = makeSession({
      slug: "alpha",
      title: "Alpha",
      attention: [flag("needs_input", "2026-04-30T10:00:00Z")],
    });
    useSessionStore.getState().replaceAll(TEST_CONN.id, [s]);

    await act(async () => {
      root.render(createElement(InboxView, { api: API }));
    });
    await flush();

    const btn = container.querySelector(
      '[data-testid="inbox-title-alpha-needs_input"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn?.click();
    });

    expect(setUrlStateMock).toHaveBeenCalledTimes(1);
    expect(setUrlStateMock.mock.calls[0]![0]).toMatchObject({
      connectionId: TEST_CONN.id,
      view: "list",
      sessionSlug: "alpha",
    });
  });

  it("clicking dismiss calls dismissAttention with { sessionSlug, attentionKind }", async () => {
    const s = makeSession({
      slug: "alpha",
      title: "Alpha",
      attention: [flag("needs_input", "2026-04-30T10:00:00Z")],
    });
    useSessionStore.getState().replaceAll(TEST_CONN.id, [s]);
    dismissAttentionMock.mockResolvedValue({ ok: true });

    await act(async () => {
      root.render(createElement(InboxView, { api: API }));
    });
    await flush();

    const btn = container.querySelector(
      '[data-testid="inbox-dismiss-alpha-needs_input"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn?.click();
    });
    await flush();

    expect(dismissAttentionMock).toHaveBeenCalledTimes(1);
    const call = dismissAttentionMock.mock.calls[0]!;
    expect(call[1]).toBe("alpha");
    expect(call[2]).toBe("needs_input");
    expect(container.querySelector('[data-testid="inbox-row-alpha-needs_input"]')).toBeNull();
  });
});
