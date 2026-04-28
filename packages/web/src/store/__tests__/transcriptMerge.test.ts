import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../sessionStore.js";
import type { TranscriptEvent } from "../../types.js";

const SLUG = "demo";
const CONN = "conn-1";

function makeEvent(seq: number, text: string): TranscriptEvent {
  return {
    kind: "assistant_text",
    id: `e${seq}-${text}`,
    sessionSlug: SLUG,
    seq,
    turn: 0,
    timestamp: "2026-01-01T00:00:00Z",
    text,
  };
}

function transcript(): TranscriptEvent[] {
  return useSessionStore.getState().byConnection.get(CONN)?.transcripts.get(SLUG) ?? [];
}

describe("sessionStore transcript merge-by-seq", () => {
  beforeEach(() => {
    useSessionStore.setState({ byConnection: new Map() });
  });

  it("appendTranscriptEvent appends in seq order on the fast path", () => {
    const store = useSessionStore.getState();
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(1, "a"));
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(2, "b"));
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(3, "c"));
    expect(transcript().map(e => e.seq)).toEqual([1, 2, 3]);
  });

  it("appendTranscriptEvent dedupes by seq when an event repeats", () => {
    const store = useSessionStore.getState();
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(1, "a"));
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(2, "b"));
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(2, "b-dup"));
    const seqs = transcript().map(e => e.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it("appendTranscriptEvent reorders if an out-of-order event arrives", () => {
    const store = useSessionStore.getState();
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(1, "a"));
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(3, "c"));
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(2, "b"));
    expect(transcript().map(e => e.seq)).toEqual([1, 2, 3]);
  });

  it("setTranscript merges existing + new events and dedupes by seq", () => {
    const store = useSessionStore.getState();
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(1, "a"));
    store.appendTranscriptEvent(CONN, SLUG, makeEvent(2, "b"));
    store.setTranscript(CONN, SLUG, [
      makeEvent(2, "b-2"),
      makeEvent(3, "c"),
      makeEvent(4, "d"),
    ]);
    const seqs = transcript().map(e => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("setTranscript on empty store sorts a shuffled batch by seq", () => {
    const store = useSessionStore.getState();
    store.setTranscript(CONN, SLUG, [
      makeEvent(3, "c"),
      makeEvent(1, "a"),
      makeEvent(2, "b"),
    ]);
    expect(transcript().map(e => e.seq)).toEqual([1, 2, 3]);
  });
});
