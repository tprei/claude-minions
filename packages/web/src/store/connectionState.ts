import type { Connection } from "../connections/store.js";
import { connectWorkflowSse } from "../transport/sse.js";
import { getVersion, listWorkflows } from "../transport/rest.js";
import { loadSnapshot, saveSnapshot } from "../transport/snapshotCache.js";
import { useWorkflowStore } from "./workflowStore.js";
import { useVersionStore } from "./version.js";
import type { SseConnection } from "../transport/sse.js";
import type { Workflow } from "@minions/engine";

async function refetch(conn: Connection, isDisposed: () => boolean): Promise<Workflow[]> {
  const [version, workflows] = await Promise.all([
    getVersion(conn),
    listWorkflows(conn, { includeCompleted: true }),
  ]);
  if (isDisposed()) return [];
  useVersionStore.getState().setVersion(conn.id, version);
  useWorkflowStore.getState().replaceAll(conn.id, workflows);
  useVersionStore.getState().seedFromWorkflows(
    conn.id,
    workflows.map((w) => ({ workflowId: w.id, version: w.version })),
  );
  await saveSnapshot(conn.id, { workflows });
  return workflows;
}

export async function refetchConnection(conn: Connection): Promise<void> {
  await refetch(conn, () => false);
}

// TODO(T54): add coverage for attach/dispose races.
export function attachConnection(conn: Connection, delayMs = 0): () => void {
  let disposed = false;
  let disposeTimer: ReturnType<typeof setTimeout> | null = null;
  // Per-workflow SSE connections, keyed by workflowId.
  const sseConns = new Map<string, SseConnection>();
  const isDisposed = (): boolean => disposed;
  const unsubscribeWorkflowStore = useWorkflowStore.subscribe((state) => {
    const workflows = [...(state.byConnection.get(conn.id)?.values() ?? [])];
    openSseForWorkflows(workflows);
  });

  function teardownSse(): void {
    for (const c of sseConns.values()) c.close();
    sseConns.clear();
  }

  function openSseForWorkflows(workflows: Workflow[]): void {
    if (disposed) return;

    // Close SSE for workflows no longer present.
    for (const [wid, sseConn] of sseConns) {
      if (!workflows.some((w) => w.id === wid)) {
        sseConn.close();
        sseConns.delete(wid);
      }
    }

    // Open SSE for new workflows.
    for (const workflow of workflows) {
      if (sseConns.has(workflow.id)) continue;
      const sseConn = connectWorkflowSse(conn, workflow.id, {
        onEvent(event) {
          if (disposed) return;
          useWorkflowStore.getState().applyEvent(conn.id, event);
          const w = useWorkflowStore.getState().byConnection.get(conn.id)?.get(event.workflowId);
          if (w) {
            useVersionStore.getState().setWorkflowVersion(conn.id, w.id, w.version);
          }
        },
        async onReconnect() {
          if (disposed) return;
          try {
            const fresh = await refetch(conn, isDisposed);
            openSseForWorkflows(fresh);
          } catch {
            // non-fatal — next onReconnect will retry
          }
        },
      });
      sseConns.set(workflow.id, sseConn);
    }
  }

  async function init(): Promise<void> {
    const snapshot = await loadSnapshot(conn.id);
    if (disposed) return;
    if (snapshot) {
      useWorkflowStore.getState().replaceAll(conn.id, snapshot.workflows);
      useVersionStore.getState().seedFromWorkflows(
        conn.id,
        snapshot.workflows.map((w) => ({ workflowId: w.id, version: w.version })),
      );
    }

    // Always force a fresh REST fetch on attach so stale snapshots don't
    // persist across engine restarts.
    let workflows: Workflow[] = snapshot?.workflows ?? [];
    try {
      workflows = await refetch(conn, isDisposed);
    } catch {
      // non-fatal — snapshot data remains; SSE onReconnect will retry
    }

    if (disposed) return;
    openSseForWorkflows(workflows);
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
    unsubscribeWorkflowStore();
    if (disposeTimer !== null) {
      clearTimeout(disposeTimer);
      disposeTimer = null;
    }
    teardownSse();
  };
}
