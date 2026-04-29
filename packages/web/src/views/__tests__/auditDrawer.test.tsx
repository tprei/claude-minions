import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AuditEvent, ListEnvelope } from "@minions/shared";
import { useConnectionStore } from "../../connections/store.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getAuditEventsMock = vi.fn<[unknown, string?], Promise<ListEnvelope<AuditEvent>>>();

vi.mock("../../transport/rest.js", () => ({
  getAuditEvents: (conn: unknown, cursor?: string) => getAuditEventsMock(conn, cursor),
}));

const { AuditDrawer } = await import("../auditDrawer.js");

let container: HTMLDivElement;
let root: Root;

const TEST_CONN = {
  id: "conn-1",
  label: "Test",
  baseUrl: "http://localhost:9999",
  token: "tok",
  color: "#7c5cff",
};

function setActiveConnection(): void {
  useConnectionStore.setState({
    connections: [TEST_CONN],
    activeId: TEST_CONN.id,
    _hydrated: true,
  });
}

function clearConnection(): void {
  useConnectionStore.setState({
    connections: [],
    activeId: null,
    _hydrated: true,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  getAuditEventsMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  clearConnection();
});

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    timestamp: "2026-04-29T10:00:00.000Z",
    actor: "alice",
    action: "session.created",
    target: { kind: "session", id: "sess-1" },
    detail: { reason: "manual" },
    ...overrides,
  };
}

describe("AuditDrawer", () => {
  it("renders rows from getAuditEvents() with action, actor, target, and timestamp", async () => {
    setActiveConnection();
    getAuditEventsMock.mockResolvedValueOnce({
      items: [makeEvent({ id: "a", action: "session.created", actor: "alice" })],
    });

    await act(async () => {
      root.render(createElement(AuditDrawer, { onClose: () => {} }));
    });
    await flush();

    const rows = container.querySelectorAll('[data-testid="audit-row"]');
    expect(rows.length).toBe(1);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("session.created");
    expect(text).toContain("alice");
    expect(text).toContain("session:sess-1");
  });

  it("expands the body preview when the row is clicked", async () => {
    setActiveConnection();
    getAuditEventsMock.mockResolvedValueOnce({
      items: [makeEvent({ detail: { reason: "manual", count: 3 } })],
    });

    await act(async () => {
      root.render(createElement(AuditDrawer, { onClose: () => {} }));
    });
    await flush();

    expect(container.querySelector('[data-testid="audit-body"]')).toBeNull();

    const button = container.querySelector('[data-testid="audit-row"] button') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    const body = container.querySelector('[data-testid="audit-body"]');
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("manual");
    expect(body?.textContent).toContain("\"count\": 3");
  });

  it("renders Load more when nextCursor is set and fetches the next page", async () => {
    setActiveConnection();
    getAuditEventsMock.mockResolvedValueOnce({
      items: [makeEvent({ id: "a" })],
      nextCursor: "cursor-1",
    });

    await act(async () => {
      root.render(createElement(AuditDrawer, { onClose: () => {} }));
    });
    await flush();

    const loadMore = container.querySelector('[data-testid="audit-load-more"]') as HTMLButtonElement;
    expect(loadMore).not.toBeNull();

    getAuditEventsMock.mockResolvedValueOnce({
      items: [makeEvent({ id: "b", action: "session.deleted" })],
    });

    await act(async () => {
      loadMore.click();
    });
    await flush();

    expect(getAuditEventsMock).toHaveBeenLastCalledWith(expect.anything(), "cursor-1");
    const rows = container.querySelectorAll('[data-testid="audit-row"]');
    expect(rows.length).toBe(2);
    expect(container.querySelector('[data-testid="audit-load-more"]')).toBeNull();
  });

  it("hides Load more when nextCursor is absent", async () => {
    setActiveConnection();
    getAuditEventsMock.mockResolvedValueOnce({
      items: [makeEvent()],
    });

    await act(async () => {
      root.render(createElement(AuditDrawer, { onClose: () => {} }));
    });
    await flush();

    expect(container.querySelector('[data-testid="audit-load-more"]')).toBeNull();
  });

  it("shows an empty state when there are no events", async () => {
    setActiveConnection();
    getAuditEventsMock.mockResolvedValueOnce({ items: [] });

    await act(async () => {
      root.render(createElement(AuditDrawer, { onClose: () => {} }));
    });
    await flush();

    expect(container.textContent).toContain("No audit events");
  });

  it("surfaces fetch errors with role=alert", async () => {
    setActiveConnection();
    getAuditEventsMock.mockRejectedValueOnce(new Error("boom"));

    await act(async () => {
      root.render(createElement(AuditDrawer, { onClose: () => {} }));
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("boom");
  });
});
