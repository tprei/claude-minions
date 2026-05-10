/**
 * @deprecated Use workflowStore / taskStore instead.
 *
 * This module is a compatibility shim. The session concept no longer exists
 * in the new domain — the analogous entity is TaskNode inside a Workflow.
 * This re-export exists so downstream components (chat/, views/) continue to
 * import from this path without a module-not-found error while steps 6-7
 * migrate each call site to the new API.
 */
export {
  useWorkflowStore as useSessionStore,
  selectTaskNodes,
  selectTaskNode,
} from "./workflowStore.js";
