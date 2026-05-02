import type { SessionBucket } from "@minions/shared";
import type { ViewKind } from "../routing/parseUrl.js";
import { parseUrl } from "../routing/parseUrl.js";
import { ListView } from "./list.js";
import { KanbanView } from "./kanban.js";
import { DagCanvasView } from "./dagCanvas.js";
import { ShipPipelineView } from "./shipPipeline.js";
import { NewSessionView } from "./newSession.js";
import { DoctorView } from "./doctor.js";
import { LoopsView } from "./loops.js";
import { InboxView } from "./inbox.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed" | "attention";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";
type FilterBucket = "all" | SessionBucket;

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string, body?: unknown) => Promise<unknown>;
}

interface Props {
  view: ViewKind;
  filterStatus?: FilterStatus;
  filterMode?: FilterMode;
  filterBucket?: FilterBucket;
  sessionSlug?: string | null;
  api?: ApiClient | null;
}

export function ViewSwitcher({ view, filterStatus, filterMode, filterBucket, sessionSlug, api }: Props) {
  const { query } = parseUrl();
  const dagId = query["dag"];

  switch (view) {
    case "list":
      return <ListView filterStatus={filterStatus} filterMode={filterMode} filterBucket={filterBucket} />;
    case "kanban":
      return <KanbanView filterStatus={filterStatus} filterMode={filterMode} />;
    case "dag":
      return <DagCanvasView sessionSlug={sessionSlug} dagId={dagId} />;
    case "ship":
      return <ShipPipelineView sessionSlug={sessionSlug} />;
    case "new":
      return api ? <NewSessionView api={api} /> : <ListView filterStatus={filterStatus} filterMode={filterMode} filterBucket={filterBucket} />;
    case "doctor":
      return api ? <DoctorView api={api} /> : <ListView filterStatus={filterStatus} filterMode={filterMode} filterBucket={filterBucket} />;
    case "loops":
      return api ? <LoopsView api={api} /> : <ListView filterStatus={filterStatus} filterMode={filterMode} filterBucket={filterBucket} />;
    case "inbox":
      return api ? <InboxView api={api} /> : <ListView filterStatus={filterStatus} filterMode={filterMode} filterBucket={filterBucket} />;
    default:
      return <ListView filterStatus={filterStatus} filterMode={filterMode} filterBucket={filterBucket} />;
  }
}
