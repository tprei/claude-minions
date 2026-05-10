import { create } from "zustand";

/**
 * Tracks the last known version number for each workflow, used for optimistic
 * concurrency detection. When a WorkflowEvent arrives the store version should
 * be bumped to prevent stale reads from triggering false conflicts.
 */

interface WorkflowVersionEntry {
  workflowId: string;
  version: number;
}

interface VersionStore {
  /** connId → workflowId → version */
  byConnection: Map<string, Map<string, number>>;
  setWorkflowVersion: (connId: string, workflowId: string, version: number) => void;
  getWorkflowVersion: (connId: string, workflowId: string) => number | undefined;
  /** Bulk-seed versions from a snapshot of workflows. */
  seedFromWorkflows: (connId: string, entries: WorkflowVersionEntry[]) => void;
}

export const useVersionStore = create<VersionStore>((set, get) => ({
  byConnection: new Map(),

  setWorkflowVersion(connId, workflowId, version) {
    set(s => {
      const byConnection = new Map(s.byConnection);
      const inner = new Map(byConnection.get(connId) ?? []);
      inner.set(workflowId, version);
      byConnection.set(connId, inner);
      return { byConnection };
    });
  },

  getWorkflowVersion(connId, workflowId) {
    return get().byConnection.get(connId)?.get(workflowId);
  },

  seedFromWorkflows(connId, entries) {
    set(s => {
      const byConnection = new Map(s.byConnection);
      const inner = new Map(byConnection.get(connId) ?? []);
      for (const { workflowId, version } of entries) {
        inner.set(workflowId, version);
      }
      byConnection.set(connId, inner);
      return { byConnection };
    });
  },
}));

/**
 * Detect a version conflict: returns true when the local version for a
 * workflow is ahead of the incoming event's implied version. Callers use
 * this to decide whether to rollback an optimistic change or accept the
 * authoritative snapshot.
 */
export function hasVersionConflict(
  connId: string,
  workflowId: string,
  incomingVersion: number,
): boolean {
  const local = useVersionStore.getState().getWorkflowVersion(connId, workflowId);
  if (local === undefined) return false;
  return local > incomingVersion;
}
