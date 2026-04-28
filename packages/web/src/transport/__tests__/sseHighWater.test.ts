import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Connection } from "../../connections/store.js";
import type { TranscriptEvent } from "../../types.js";

const { fetchTranscriptMock } = vi.hoisted(() => ({
  fetchTranscriptMock: vi.fn(),
}));

vi.mock("../rest.js", () => ({
  fetchTranscript: fetchTranscriptMock,
}));

import { connectSse } from "../sse.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Set<(e: { type: string; data?: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(kind: string, handler: (e: { type: string; data?: string }) => void): void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(handler);
  }
  removeEventListener(kind: string, handler: (e: { type: string; data?: string }) => void): void {
    this.listeners.get(kind)?.delete(handler);
  }
  close(): void {
    this.closed = true;
  }
  fire(kind: string, payload?: unknown): void {
    const event = payload === undefined
      ? { type: kind }
      : { type: kind, data: JSON.stringify(payload) };
    for (const h of [...(this.listeners.get(kind) ?? [])]) h(event);
  }
}

const CONN: Connection = {
  id: "conn-x",
  label: "x",
  baseUrl: "http://test",
  token: "tok",
  color: "#fff",
};

function txEvent(slug: string, seq: number): TranscriptEvent {
  return {
    kind: "assistant_text",
    id: `e-${slug}-${seq}`,
    sessionSlug: slug,
    seq,
    turn: 0,
    timestamp: "2026-01-01T00:00:00Z",
    text: `t${seq}`,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe("connectSse high-water + backfill on reconnect", () => {
  beforeEach(() => {
    FakeEventSource.instances.length = 0;
    fetchTranscriptMock.mockReset();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requests fetchTranscript with the high-water seq after reconnect", async () => {
    fetchTranscriptMock.mockResolvedValue({ items: [] });

    const onTranscriptEvent = vi.fn();
    const sse = connectSse(CONN, { onTranscriptEvent });

    expect(FakeEventSource.instances).toHaveLength(1);
    const es0 = FakeEventSource.instances[0]!;
    expect(es0.url).toBe("http://test/api/events?token=tok");

    es0.fire("open");
    es0.fire("hello", { kind: "hello" });
    expect(fetchTranscriptMock).not.toHaveBeenCalled();

    es0.fire("transcript_event", { kind: "transcript_event", sessionSlug: "alpha", event: txEvent("alpha", 1) });
    es0.fire("transcript_event", { kind: "transcript_event", sessionSlug: "alpha", event: txEvent("alpha", 2) });
    es0.fire("transcript_event", { kind: "transcript_event", sessionSlug: "alpha", event: txEvent("alpha", 5) });
    expect(onTranscriptEvent).toHaveBeenCalledTimes(3);

    es0.fire("error");
    expect(es0.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    const es1 = FakeEventSource.instances[1]!;

    es1.fire("hello", { kind: "hello" });
    await flushMicrotasks();

    expect(fetchTranscriptMock).toHaveBeenCalledTimes(1);
    expect(fetchTranscriptMock).toHaveBeenCalledWith(CONN, "alpha", 5);

    sse.close();
  });

  it("dispatches only events past the high-water from the backfill response", async () => {
    fetchTranscriptMock.mockResolvedValue({
      items: [txEvent("alpha", 5), txEvent("alpha", 6), txEvent("alpha", 7)],
    });

    const onTranscriptEvent = vi.fn();
    const sse = connectSse(CONN, { onTranscriptEvent });
    const es0 = FakeEventSource.instances[0]!;

    es0.fire("open");
    es0.fire("hello", { kind: "hello" });
    es0.fire("transcript_event", { kind: "transcript_event", sessionSlug: "alpha", event: txEvent("alpha", 5) });
    expect(onTranscriptEvent).toHaveBeenCalledTimes(1);
    onTranscriptEvent.mockClear();

    es0.fire("error");
    await vi.advanceTimersByTimeAsync(31_000);
    const es1 = FakeEventSource.instances[1]!;
    es1.fire("hello", { kind: "hello" });
    await flushMicrotasks();

    const seqs = onTranscriptEvent.mock.calls.map(
      (args) => (args[0] as { event: { seq: number } }).event.seq,
    );
    expect(seqs).toEqual([6, 7]);

    sse.close();
  });

  it("tracks high-water per slug and backfills each from its own seq", async () => {
    fetchTranscriptMock.mockResolvedValue({ items: [] });

    const sse = connectSse(CONN, { onTranscriptEvent: vi.fn() });
    const es0 = FakeEventSource.instances[0]!;
    es0.fire("open");
    es0.fire("hello", { kind: "hello" });

    es0.fire("transcript_event", { kind: "transcript_event", sessionSlug: "alpha", event: txEvent("alpha", 4) });
    es0.fire("transcript_event", { kind: "transcript_event", sessionSlug: "beta", event: txEvent("beta", 9) });

    es0.fire("error");
    await vi.advanceTimersByTimeAsync(31_000);
    FakeEventSource.instances[1]!.fire("hello", { kind: "hello" });
    await flushMicrotasks();

    expect(fetchTranscriptMock).toHaveBeenCalledTimes(2);
    const calls = fetchTranscriptMock.mock.calls.map((c) => [c[1], c[2]]);
    expect(calls).toEqual(expect.arrayContaining([["alpha", 4], ["beta", 9]]));

    sse.close();
  });

  it("does not backfill on the very first hello (no prior session)", async () => {
    fetchTranscriptMock.mockResolvedValue({ items: [] });

    const sse = connectSse(CONN, { onTranscriptEvent: vi.fn() });
    const es0 = FakeEventSource.instances[0]!;
    es0.fire("open");
    es0.fire("hello", { kind: "hello" });
    es0.fire("transcript_event", { kind: "transcript_event", sessionSlug: "alpha", event: txEvent("alpha", 3) });

    await flushMicrotasks();
    expect(fetchTranscriptMock).not.toHaveBeenCalled();

    sse.close();
  });
});
