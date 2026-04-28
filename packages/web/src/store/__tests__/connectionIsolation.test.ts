import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../sessionStore.js";
import type { Session } from "../../types.js";

function makeSession(slug: string, title: string): Session {
  return {
    slug,
    title,
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
    provider: "anthropic",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    metadata: {},
  };
}

describe("sessionStore connection isolation", () => {
  beforeEach(() => {
    useSessionStore.setState({ byConnection: new Map() });
  });

  it("keeps sessions on different connections separate", () => {
    const store = useSessionStore.getState();
    store.upsertSession("conn-a", makeSession("alpha", "A-alpha"));
    store.upsertSession("conn-b", makeSession("beta", "B-beta"));

    const after = useSessionStore.getState().byConnection;
    expect(after.get("conn-a")?.sessions.has("alpha")).toBe(true);
    expect(after.get("conn-a")?.sessions.has("beta")).toBe(false);
    expect(after.get("conn-b")?.sessions.has("beta")).toBe(true);
    expect(after.get("conn-b")?.sessions.has("alpha")).toBe(false);
  });

  it("replaceAll on one connection does not clear the other", () => {
    const store = useSessionStore.getState();
    store.upsertSession("conn-a", makeSession("alpha", "A-alpha"));
    store.upsertSession("conn-b", makeSession("beta", "B-beta"));

    store.replaceAll("conn-a", [makeSession("gamma", "A-gamma")]);

    const after = useSessionStore.getState().byConnection;
    expect([...(after.get("conn-a")?.sessions.keys() ?? [])]).toEqual(["gamma"]);
    expect(after.get("conn-b")?.sessions.has("beta")).toBe(true);
  });

  it("removeSession on one connection does not touch the other's same-slug entry", () => {
    const store = useSessionStore.getState();
    store.upsertSession("conn-a", makeSession("shared", "A-shared"));
    store.upsertSession("conn-b", makeSession("shared", "B-shared"));

    store.removeSession("conn-a", "shared");

    const after = useSessionStore.getState().byConnection;
    expect(after.get("conn-a")?.sessions.has("shared")).toBe(false);
    expect(after.get("conn-b")?.sessions.get("shared")?.title).toBe("B-shared");
  });

  it("transcripts on different connections do not leak across", () => {
    const store = useSessionStore.getState();
    store.appendTranscriptEvent("conn-a", "shared", {
      kind: "assistant_text",
      id: "a1",
      sessionSlug: "shared",
      seq: 1,
      turn: 0,
      timestamp: "2026-01-01T00:00:00Z",
      text: "from-a",
    });
    store.appendTranscriptEvent("conn-b", "shared", {
      kind: "assistant_text",
      id: "b1",
      sessionSlug: "shared",
      seq: 1,
      turn: 0,
      timestamp: "2026-01-01T00:00:00Z",
      text: "from-b",
    });

    const after = useSessionStore.getState().byConnection;
    const aEvents = after.get("conn-a")?.transcripts.get("shared") ?? [];
    const bEvents = after.get("conn-b")?.transcripts.get("shared") ?? [];
    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    expect(aEvents[0]?.kind === "assistant_text" && aEvents[0].text).toBe("from-a");
    expect(bEvents[0]?.kind === "assistant_text" && bEvents[0].text).toBe("from-b");
  });
});
