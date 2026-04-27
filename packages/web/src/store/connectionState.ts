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
  useSessionStore.getState().replaceAll(sessions);
  useDagStore.getState().replaceAll(dags);
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
      useSessionStore.getState().replaceAll(snapshot.sessions);
      useDagStore.getState().replaceAll(snapshot.dags);
    }

    await fetchVersion(conn);

    if (disposed) return;

    sseConn = connectSse(conn, {
      onSessionCreated(e) { useSessionStore.getState().upsertSession(e.session); },
      onSessionUpdated(e) { useSessionStore.getState().upsertSession(e.session); },
      onSessionDeleted(e) { useSessionStore.getState().removeSession(e.slug); },
      onDagCreated(e) { useDagStore.getState().upsert(e.dag); },
      onDagUpdated(e) { useDagStore.getState().upsert(e.dag); },
      onDagDeleted(e) { useDagStore.getState().remove(e.id); },
      onTranscriptEvent(e) {
        useSessionStore.getState().appendTranscriptEvent(e.sessionSlug, e.event);
      },
      onResource(e) { useResourceStore.getState().push(e.snapshot); },
      onMemoryProposed(e) { useMemoryStore.getState().upsert(e.memory); },
      onMemoryUpdated(e) { useMemoryStore.getState().upsert(e.memory); },
      onMemoryReviewed(e) { useMemoryStore.getState().upsert(e.memory); },
      onMemoryDeleted(e) { useMemoryStore.getState().remove(e.id); },
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
