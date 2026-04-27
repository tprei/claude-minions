import type { ViewKind } from "../routing/parseUrl.js";
import { parseUrl } from "../routing/parseUrl.js";
import { ListView } from "./list.js";
import { KanbanView } from "./kanban.js";
import { DagCanvasView } from "./dagCanvas.js";
import { ShipPipelineView } from "./shipPipeline.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";

interface Props {
  view: ViewKind;
  filterStatus?: FilterStatus;
  filterMode?: FilterMode;
  sessionSlug?: string | null;
}

export function ViewSwitcher({ view, filterStatus, filterMode, sessionSlug }: Props) {
  const { query } = parseUrl();
  const dagId = query["dag"];

  switch (view) {
    case "list":
      return <ListView filterStatus={filterStatus} filterMode={filterMode} />;
    case "kanban":
      return <KanbanView filterStatus={filterStatus} filterMode={filterMode} />;
    case "dag":
      return <DagCanvasView sessionSlug={sessionSlug} dagId={dagId} />;
    case "ship":
      return <ShipPipelineView sessionSlug={sessionSlug} />;
    default:
      return <ListView filterStatus={filterStatus} filterMode={filterMode} />;
  }
}
