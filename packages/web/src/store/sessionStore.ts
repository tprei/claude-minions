import { create } from "zustand";
import type { Session, TranscriptEvent } from "../types.js";

interface SessionStore {
  sessions: Map<string, Session>;
  transcripts: Map<string, TranscriptEvent[]>;
  replaceAll: (sessions: Session[]) => void;
  upsertSession: (session: Session) => void;
  removeSession: (slug: string) => void;
  appendTranscriptEvent: (slug: string, event: TranscriptEvent) => void;
  setTranscript: (slug: string, events: TranscriptEvent[]) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: new Map(),
  transcripts: new Map(),

  replaceAll(sessions) {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.slug, s);
    set({ sessions: map });
  },

  upsertSession(session) {
    set(s => {
      const sessions = new Map(s.sessions);
      sessions.set(session.slug, session);
      return { sessions };
    });
  },

  removeSession(slug) {
    set(s => {
      const sessions = new Map(s.sessions);
      sessions.delete(slug);
      const transcripts = new Map(s.transcripts);
      transcripts.delete(slug);
      return { sessions, transcripts };
    });
  },

  appendTranscriptEvent(slug, event) {
    set(s => {
      const transcripts = new Map(s.transcripts);
      const existing = transcripts.get(slug) ?? [];
      const last = existing.length > 0 ? existing[existing.length - 1] : undefined;
      if (last && last.seq >= event.seq) {
        return { transcripts: s.transcripts };
      }
      transcripts.set(slug, [...existing, event]);
      return { transcripts };
    });
  },

  setTranscript(slug, events) {
    set(s => {
      const transcripts = new Map(s.transcripts);
      transcripts.set(slug, [...events].sort((a, b) => a.seq - b.seq));
      return { transcripts };
    });
  },
}));
