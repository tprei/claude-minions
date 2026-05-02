import type { Connection } from "../connections/store.js";
import { connectSse } from "../transport/sse.js";
import { getSessions, getDags, getVersion, getRuntimeConfig } from "../transport/rest.js";
import { loadSnapshot, saveSnapshot } from "../transport/snapshotCache.js";
import { useSessionStore } from "./sessionStore.js";
import { useDagStore } from "./dagStore.js";
import { useResourceStore } from "./resourceStore.js";
import { useMemoryStore } from "./memoryStore.js";
import { useVersionStore } from "./version.js";
import { useRuntimeStore } from "./runtimeStore.js";

async function refetch(conn: Connection, isDisposed: () => boolean): Promise<void> {
  const [sessionsEnv, dagsEnv] = await Promise.all([
    getSessions(conn),
    getDags(conn),
  ]);
  if (isDisposed()) return;
  const sessions = sessionsEnv.items;
  const dags = dagsEnv.items;
  useSessionStore.getState().replaceAll(conn.id, sessions);
  useDagStore.getState().replaceAll(conn.id, dags);
  await saveSnapshot(conn.id, { sessions, dags });
}

export async function refetchConnection(conn: Connection): Promise<void> {
  await refetch(conn, () => false);
}

async function fetchVersion(conn: Connection, isDisposed: () => boolean): Promise<void> {
  try {
    const info = await getVersion(conn);
    if (isDisposed()) return;
    useVersionStore.getState().setVersion(conn.id, info);
  } catch {
    // non-fatal — features will be empty
  }
}

async function fetchRuntime(conn: Connection, isDisposed: () => boolean): Promise<void> {
  try {
    const res = await getRuntimeConfig(conn);
    if (isDisposed()) return;
    useRuntimeStore.getState().replace(conn.id, res.schema, res.values, res.effective);
  } catch {
    // non-fatal — runtime indicator will simply stay absent
  }
}

// TODO(T54): once the vitest harness lands, add coverage that detaches a
// connection while init() is mid-flight (snapshot load, version fetch, and
// onReconnect refetch) and asserts no entries remain in session/dag/version
// stores for that conn.id.
export function attachConnection(conn: Connection, delayMs = 0): () => void {
  let disposed = false;
  let disposeTimer: ReturnType<typeof setTimeout> | null = null;
  let sseConn: ReturnType<typeof connectSse> | null = null;
  const isDisposed = (): boolean => disposed;

  async function init(): Promise<void> {
    const snapshot = await loadSnapshot(conn.id);
    if (disposed) return;
    if (snapshot) {
      useSessionStore.getState().replaceAll(conn.id, snapshot.sessions);
      useDagStore.getState().replaceAll(conn.id, snapshot.dags);
    }

    // Always force a fresh REST fetch on attach. The snapshot may be empty
    // (first attach for this connection / cache cleared) or stale (engine
    // produced new sessions/dags while the tab was closed). Without this,
    // fresh data only arrives via SSE's onReconnect callback, which races
    // the user's first navigation — they can land on a DAG view and see
    // "No DAGs available" before SSE has finished opening.
    try {
      await refetch(conn, isDisposed);
    } catch {
      // non-fatal — SSE onReconnect will retry on first connect
    }

    await fetchVersion(conn, isDisposed);
    await fetchRuntime(conn, isDisposed);

    if (disposed) return;

    sseConn = connectSse(conn, {
      onSessionCreated(e) { useSessionStore.getState().upsertSession(conn.id, e.session); },
      onSessionUpdated(e) { useSessionStore.getState().upsertSession(conn.id, e.session); },
      onSessionDeleted(e) { useSessionStore.getState().removeSession(conn.id, e.slug); },
      onDagCreated(e) { useDagStore.getState().upsert(conn.id, e.dag); },
      onDagUpdated(e) { useDagStore.getState().upsert(conn.id, e.dag); },
      onDagDeleted(e) { useDagStore.getState().remove(conn.id, e.id); },
      onDagNodeUpdated(e) { useDagStore.getState().upsertNode(conn.id, e.dagId, e.node); },
      onTranscriptEvent(e) {
        useSessionStore.getState().appendTranscriptEvent(conn.id, e.sessionSlug, e.event);
      },
      onResource(e) { useResourceStore.getState().push(conn.id, e.snapshot); },
      onMemoryProposed(e) { useMemoryStore.getState().upsert(conn.id, e.memory); },
      onMemoryUpdated(e) { useMemoryStore.getState().upsert(conn.id, e.memory); },
      onMemoryReviewed(e) { useMemoryStore.getState().upsert(conn.id, e.memory); },
      onMemoryDeleted(e) { useMemoryStore.getState().remove(conn.id, e.id); },
      async onReconnect() {
        if (disposed) return;
        await refetch(conn, isDisposed);
        await fetchRuntime(conn, isDisposed);
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
