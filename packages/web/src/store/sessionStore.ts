// T32 will close the multi-connection isolation regression — see docs/dogfood-tasks.md
import { create } from "zustand";
import type { Session, TranscriptEvent } from "../types.js";

export interface SessionSlice {
  sessions: Map<string, Session>;
  transcripts: Map<string, TranscriptEvent[]>;
}

interface SessionStore {
  byConnection: Map<string, SessionSlice>;
  replaceAll: (connId: string, sessions: Session[]) => void;
  upsertSession: (connId: string, session: Session) => void;
  removeSession: (connId: string, slug: string) => void;
  appendTranscriptEvent: (connId: string, slug: string, event: TranscriptEvent) => void;
  setTranscript: (connId: string, slug: string, events: TranscriptEvent[]) => void;
  /**
   * Apply an optimistic mutation to a session. Returns a rollback closure that
   * restores the prior state when invoked. If the session is missing the
   * mutation no-ops and the rollback is a no-op.
   */
  applyOptimisticSession: (
    connId: string,
    slug: string,
    mutator: (prev: Session) => Session,
  ) => () => void;
}

export const EMPTY_SESSIONS: Map<string, Session> = new Map();
export const EMPTY_TRANSCRIPTS: Map<string, TranscriptEvent[]> = new Map();

function withSlice(
  byConnection: Map<string, SessionSlice>,
  connId: string,
  mutator: (slice: SessionSlice) => void,
): Map<string, SessionSlice> {
  const next = new Map(byConnection);
  const existing = next.get(connId);
  const slice: SessionSlice = {
    sessions: existing ? new Map(existing.sessions) : new Map(),
    transcripts: existing ? new Map(existing.transcripts) : new Map(),
  };
  mutator(slice);
  next.set(connId, slice);
  return next;
}

export const useSessionStore = create<SessionStore>((set) => ({
  byConnection: new Map(),

  replaceAll(connId, sessions) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.sessions = new Map();
        for (const sess of sessions) slice.sessions.set(sess.slug, sess);
      }),
    }));
  },

  upsertSession(connId, session) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.sessions.set(session.slug, session);
      }),
    }));
  },

  removeSession(connId, slug) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.sessions.delete(slug);
        slice.transcripts.delete(slug);
      }),
    }));
  },

  appendTranscriptEvent(connId, slug, event) {
    set(s => {
      const existing = s.byConnection.get(connId)?.transcripts.get(slug) ?? [];
      const last = existing.length > 0 ? existing[existing.length - 1] : undefined;
      if (last && event.seq > last.seq) {
        return {
          byConnection: withSlice(s.byConnection, connId, (slice) => {
            slice.transcripts.set(slug, [...existing, event]);
          }),
        };
      }
      if (existing.some((e) => e.seq === event.seq)) return s;
      const merged = [...existing, event].sort((a, b) => a.seq - b.seq);
      return {
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          slice.transcripts.set(slug, merged);
        }),
      };
    });
  },

  setTranscript(connId, slug, events) {
    set(s => {
      const existing = s.byConnection.get(connId)?.transcripts.get(slug) ?? [];
      const seen = new Set<number>();
      const merged: TranscriptEvent[] = [];
      for (const e of existing) {
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        merged.push(e);
      }
      for (const e of events) {
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        merged.push(e);
      }
      merged.sort((a, b) => a.seq - b.seq);
      return {
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          slice.transcripts.set(slug, merged);
        }),
      };
    });
  },

  applyOptimisticSession(connId, slug, mutator) {
    const prev = useSessionStore.getState().byConnection.get(connId)?.sessions.get(slug);
    if (!prev) return () => {};
    const next = mutator(prev);
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.sessions.set(slug, next);
      }),
    }));
    return () => {
      set(s => ({
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          slice.sessions.set(slug, prev);
        }),
      }));
    };
  },
}));
