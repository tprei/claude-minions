import { create } from "zustand";
import type { PendingFeature, RepoBinding, VersionInfo } from "@minions/shared";

export interface ConnectionMeta {
  apiVersion: string;
  libraryVersion: string;
  buildSha: string;
  provider: string;
  providers: string[];
  features: string[];
  featuresPending: PendingFeature[];
  repos: RepoBinding[];
  pluginSet: string[];
  startedAt: string;
}

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
  /** connId → ConnectionMeta */
  byConnection: Map<string, ConnectionMeta>;
  /** connId → (workflowId → version) */
  workflowVersions: Map<string, Map<string, number>>;
  setConnectionMeta: (connId: string, meta: ConnectionMeta) => void;
  /** Alias for setConnectionMeta, accepts VersionInfo from @minions/shared for backward compat. */
  setVersion: (connId: string, info: VersionInfo) => void;
  setWorkflowVersion: (connId: string, workflowId: string, version: number) => void;
  getWorkflowVersion: (connId: string, workflowId: string) => number | undefined;
  /** Bulk-seed versions from a snapshot of workflows. */
  seedFromWorkflows: (connId: string, entries: WorkflowVersionEntry[]) => void;
  clearConnection: (connId: string) => void;
}

const EMPTY_META: ConnectionMeta = {
  apiVersion: "",
  libraryVersion: "",
  buildSha: "",
  provider: "",
  providers: [],
  features: [],
  featuresPending: [],
  repos: [],
  pluginSet: [],
  startedAt: "",
};

export const useVersionStore = create<VersionStore>((set, get) => ({
  byConnection: new Map(),
  workflowVersions: new Map(),

  setConnectionMeta(connId, meta) {
    set(s => {
      const next = new Map(s.byConnection);
      next.set(connId, meta);
      return { byConnection: next };
    });
  },

  setVersion(connId, info) {
    set(s => {
      const next = new Map(s.byConnection);
      next.set(connId, {
        apiVersion: info.apiVersion,
        libraryVersion: info.libraryVersion,
        buildSha: info.buildSha,
        provider: info.provider,
        providers: info.providers,
        features: info.features,
        featuresPending: info.featuresPending,
        repos: info.repos,
        pluginSet: info.pluginSet,
        startedAt: info.startedAt,
      });
      return { byConnection: next };
    });
  },

  setWorkflowVersion(connId, workflowId, version) {
    set(s => {
      const workflowVersions = new Map(s.workflowVersions);
      const inner = new Map(workflowVersions.get(connId) ?? []);
      inner.set(workflowId, version);
      workflowVersions.set(connId, inner);
      return { workflowVersions };
    });
  },

  getWorkflowVersion(connId, workflowId) {
    return get().workflowVersions.get(connId)?.get(workflowId);
  },

  seedFromWorkflows(connId, entries) {
    set(s => {
      const workflowVersions = new Map(s.workflowVersions);
      const inner = new Map(workflowVersions.get(connId) ?? []);
      for (const { workflowId, version } of entries) {
        inner.set(workflowId, version);
      }
      workflowVersions.set(connId, inner);
      return { workflowVersions };
    });
  },

  clearConnection(connId) {
    set((s) => {
      const byConnection = new Map(s.byConnection);
      const workflowVersions = new Map(s.workflowVersions);
      const hadConnection = byConnection.delete(connId);
      const hadVersions = workflowVersions.delete(connId);
      if (!hadConnection && !hadVersions) return s;
      return { byConnection, workflowVersions };
    });
  },
}));

/**
 * Selector: connection-level metadata (repos, features, versions).
 * Returns empty defaults when no metadata has been seeded for this connection.
 */
export function selectConnectionMeta(connId: string): ConnectionMeta {
  return useVersionStore.getState().byConnection.get(connId) ?? EMPTY_META;
}

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
