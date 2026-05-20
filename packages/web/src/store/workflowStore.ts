import { create } from "zustand";
import type { Workflow, TaskNode, WorkflowEvent } from "@minions/engine";
import { applyEventToSnapshot } from "../transport/snapshotCache.js";

interface WorkflowStore {
  byConnection: Map<string, Map<string, Workflow>>;
  replaceAll: (connId: string, workflows: Workflow[]) => void;
  upsert: (connId: string, workflow: Workflow) => void;
  remove: (connId: string, workflowId: string) => void;
  clearConnection: (connId: string) => void;
  applyEvent: (connId: string, event: WorkflowEvent) => void;
  /**
   * Apply an optimistic mutation to a workflow. Returns a rollback closure that
   * restores the prior state when invoked. No-op if the workflow is missing.
   */
  applyOptimisticWorkflow: (
    connId: string,
    workflowId: string,
    mutator: (prev: Workflow) => Workflow,
  ) => () => void;
}

export const EMPTY_WORKFLOWS: Map<string, Workflow> = new Map();

const MISSING = Symbol("missing");

interface RollbackChange {
  path: readonly (string | number)[];
  before: unknown;
  after: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => isEqual(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!isEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function collectRollbackChanges(
  before: unknown,
  after: unknown,
  path: readonly (string | number)[] = [],
): RollbackChange[] {
  if (isEqual(before, after)) return [];

  if (isRecord(before) && isRecord(after)) {
    const changes: RollbackChange[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      changes.push(...collectRollbackChanges(
        Object.hasOwn(before, key) ? before[key] : MISSING,
        Object.hasOwn(after, key) ? after[key] : MISSING,
        [...path, key],
      ));
    }
    return changes;
  }

  return [{ path, before, after }];
}

function getPathValue(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) && !Array.isArray(current)) return MISSING;
    if (!Object.hasOwn(current, segment)) return MISSING;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function setPathValue<T>(value: T, path: readonly (string | number)[], nextValue: unknown): T {
  if (path.length === 0) return nextValue as T;
  if (!isRecord(value) && !Array.isArray(value)) return value;
  const head = path[0];
  if (head === undefined) return value;
  const tail = path.slice(1);
  const clone = Array.isArray(value) ? [...value] : { ...value };
  if (tail.length === 0) {
    if (nextValue === MISSING) {
      delete (clone as Record<string | number, unknown>)[head];
    } else {
      (clone as Record<string | number, unknown>)[head] = nextValue;
    }
    return clone as T;
  }
  const child = (clone as Record<string | number, unknown>)[head];
  (clone as Record<string | number, unknown>)[head] = setPathValue(child, tail, nextValue);
  return clone as T;
}

function rollbackOptimisticChanges<T>(current: T, changes: RollbackChange[]): T {
  let next = current;
  for (const change of changes) {
    if (isEqual(getPathValue(next, change.path), change.after)) {
      next = setPathValue(next, change.path, change.before);
    }
  }
  return next;
}

function withSlice(
  byConnection: Map<string, Map<string, Workflow>>,
  connId: string,
  mutator: (slice: Map<string, Workflow>) => void,
): Map<string, Map<string, Workflow>> {
  const next = new Map(byConnection);
  const existing = next.get(connId);
  const slice = existing ? new Map(existing) : new Map<string, Workflow>();
  mutator(slice);
  next.set(connId, slice);
  return next;
}

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  byConnection: new Map(),

  replaceAll(connId, workflows) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.clear();
        for (const w of workflows) slice.set(w.id, w);
      }),
    }));
  },

  upsert(connId, workflow) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.set(workflow.id, workflow);
      }),
    }));
  },

  remove(connId, workflowId) {
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.delete(workflowId);
      }),
    }));
  },

  clearConnection(connId) {
    set((s) => {
      if (!s.byConnection.has(connId)) return s;
      const byConnection = new Map(s.byConnection);
      byConnection.delete(connId);
      return { byConnection };
    });
  },

  applyEvent(connId, event) {
    set(s => {
      const workflows = [...(s.byConnection.get(connId)?.values() ?? [])];
      const updated = applyEventToSnapshot({ workflows }, event);
      if (updated.workflows === workflows) return s;
      return {
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          slice.clear();
          for (const w of updated.workflows) slice.set(w.id, w);
        }),
      };
    });
  },

  applyOptimisticWorkflow(connId, workflowId, mutator) {
    const prev = useWorkflowStore.getState().byConnection.get(connId)?.get(workflowId);
    if (!prev) return () => {};
    const next = mutator(prev);
    const rollbackChanges = collectRollbackChanges(prev, next);
    set(s => ({
      byConnection: withSlice(s.byConnection, connId, (slice) => {
        slice.set(workflowId, next);
      }),
    }));
    return () => {
      set(s => ({
        byConnection: withSlice(s.byConnection, connId, (slice) => {
          const current = slice.get(workflowId);
          if (!current) return;
          slice.set(workflowId, rollbackOptimisticChanges(current, rollbackChanges));
        }),
      }));
    };
  },
}));

/** Selector: all workflows for a connection as a sorted array (newest first). */
export function selectWorkflows(connId: string): Workflow[] {
  const slice = useWorkflowStore.getState().byConnection.get(connId);
  if (!slice) return [];
  return [...slice.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Selector: ordered task nodes for a workflow. */
export function selectTaskNodes(connId: string, workflowId: string): TaskNode[] {
  const workflow = useWorkflowStore.getState().byConnection.get(connId)?.get(workflowId);
  if (!workflow) return [];
  return Object.values(workflow.graph);
}

/** Selector: a single task node. */
export function selectTaskNode(
  connId: string,
  workflowId: string,
  taskId: string,
): TaskNode | undefined {
  return useWorkflowStore.getState().byConnection.get(connId)?.get(workflowId)?.graph[taskId];
}
