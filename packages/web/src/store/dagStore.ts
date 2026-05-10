/**
 * @deprecated Use workflowStore instead.
 *
 * This module is a compatibility shim. The DAG concept has been unified into
 * Workflow — every workflow IS a DAG. Downstream components (views/dagCanvas,
 * views/kanban, etc.) continue to import from this path while steps 6-7
 * migrate each call site to useWorkflowStore.
 */
export {
  useWorkflowStore as useDagStore,
  EMPTY_WORKFLOWS as EMPTY_DAGS,
  selectTaskNodes,
} from "./workflowStore.js";
