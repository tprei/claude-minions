import type { Connection } from "../connections/store.js";
import { connectSse } from "../transport/sse.js";
import { getSessions, getDags, getVersion } from "../transport/rest.js";
import { loadSnapshot, saveSnapshot } from "../transport/snapshotCache.js";
import { useSessionStore } from "./sessionStore.js";
import { useDagStore } from "./dagStore.js";
import { useResourceStore } from "./resourceStore.js";
import { useMemoryStore } from "./memoryStore.js";
import { useVersionStore } from "./version.js";

async function refetch(conn: Connection): Promise<void> {
  const [sessionsEnv, dagsEnv] = await Promise.all([
    getSessions(conn),
    getDags(conn),
  ]);
  const sessions = sessionsEnv.items;
  const dags = dagsEnv.items;
  useSessionStore.getState().replaceAll(conn.id, sessions);
  useDagStore.getState().replaceAll(conn.id, dags);
  await saveSnapshot(conn.id, { sessions, dags });
}

async function fetchVersion(conn: Connection): Promise<void> {
  try {
    const info = await getVersion(conn);
    useVersionStore.getState().setVersion(conn.id, info);
  } catch {
    // non-fatal — features will be empty
  }
}

export function attachConnection(conn: Connection, delayMs = 0): () => void {
  let disposed = false;
  let disposeTimer: ReturnType<typeof setTimeout> | null = null;
  let sseConn: ReturnType<typeof connectSse> | null = null;

  async function init(): Promise<void> {
    const snapshot = await loadSnapshot(conn.id);
    if (snapshot && !disposed) {
      useSessionStore.getState().replaceAll(conn.id, snapshot.sessions);
      useDagStore.getState().replaceAll(conn.id, snapshot.dags);
    }

    await fetchVersion(conn);

    if (disposed) return;

    sseConn = connectSse(conn, {
      onSessionCreated(e) { useSessionStore.getState().upsertSession(conn.id, e.session); },
      onSessionUpdated(e) { useSessionStore.getState().upsertSession(conn.id, e.session); },
      onSessionDeleted(e) { useSessionStore.getState().removeSession(conn.id, e.slug); },
      onDagCreated(e) { useDagStore.getState().upsert(conn.id, e.dag); },
      onDagUpdated(e) { useDagStore.getState().upsert(conn.id, e.dag); },
      onDagDeleted(e) { useDagStore.getState().remove(conn.id, e.id); },
      onTranscriptEvent(e) {
        useSessionStore.getState().appendTranscriptEvent(conn.id, e.sessionSlug, e.event);
      },
      onResource(e) { useResourceStore.getState().push(conn.id, e.snapshot); },
      onMemoryProposed(e) { useMemoryStore.getState().upsert(conn.id, e.memory); },
      onMemoryUpdated(e) { useMemoryStore.getState().upsert(conn.id, e.memory); },
      onMemoryReviewed(e) { useMemoryStore.getState().upsert(conn.id, e.memory); },
      onMemoryDeleted(e) { useMemoryStore.getState().remove(conn.id, e.id); },
      async onReconnect() {
        if (!disposed) {
          await refetch(conn);
        }
      },
    });
  }

  if (delayMs > 0) {
    disposeTimer = setTimeout(() => {
      if (!disposed) void init();
    }, delayMs);
  } else {
    void init();
  }

  return () => {
    disposed = true;
    if (disposeTimer !== null) {
      clearTimeout(disposeTimer);
      disposeTimer = null;
    }
    sseConn?.close();
    sseConn = null;
  };
}
