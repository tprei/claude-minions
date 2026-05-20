import type { Connection } from "../connections/store.js";
import { connectWorkflowSse } from "../transport/sse.js";
import { getVersion, listWorkflows } from "../transport/rest.js";
import { loadSnapshot, saveSnapshot } from "../transport/snapshotCache.js";
import { useWorkflowStore } from "./workflowStore.js";
import { useVersionStore } from "./version.js";
import type { SseConnection } from "../transport/sse.js";
import type { Workflow, WorkflowEvent } from "@minions/engine";

export interface WorkflowStreamListener {
  onEvent?: (event: WorkflowEvent) => void;
  onReconnect?: () => void;
}

const workflowStreamListeners = new Map<string, Set<WorkflowStreamListener>>();

function workflowStreamKey(connId: string, workflowId: string): string {
  return `${connId}:${workflowId}`;
}

export function subscribeWorkflowStream(
  connId: string,
  workflowId: string,
  listener: WorkflowStreamListener,
): () => void {
  const key = workflowStreamKey(connId, workflowId);
  const listeners = workflowStreamListeners.get(key) ?? new Set<WorkflowStreamListener>();
  listeners.add(listener);
  workflowStreamListeners.set(key, listeners);
  return () => {
    const current = workflowStreamListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) workflowStreamListeners.delete(key);
  };
}

function publishWorkflowEvent(connId: string, event: WorkflowEvent): void {
  const listeners = workflowStreamListeners.get(workflowStreamKey(connId, event.workflowId));
  if (!listeners) return;
  for (const listener of [...listeners]) listener.onEvent?.(event);
}

function publishWorkflowReconnect(connId: string, workflowId: string): void {
  const listeners = workflowStreamListeners.get(workflowStreamKey(connId, workflowId));
  if (!listeners) return;
  for (const listener of [...listeners]) listener.onReconnect?.();
}

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
  let refetchPromise: Promise<Workflow[]> | null = null;
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

  async function refetchOnce(): Promise<Workflow[]> {
    if (refetchPromise) return await refetchPromise;
    refetchPromise = refetch(conn, isDisposed).finally(() => {
      refetchPromise = null;
    });
    return await refetchPromise;
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
          publishWorkflowEvent(conn.id, event);
        },
        async onReconnect() {
          if (disposed) return;
          try {
            const fresh = await refetchOnce();
            openSseForWorkflows(fresh);
            publishWorkflowReconnect(conn.id, workflow.id);
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
