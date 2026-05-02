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
  filterRepo: string | null;
  onFilterRepo: (repoId: string | null) => void;
  sessionSlug?: string | null;
  api?: ApiClient | null;
}

export function ViewSwitcher({ view, filterStatus, filterMode, filterBucket, filterRepo, onFilterRepo, sessionSlug, api }: Props) {
  const { query } = parseUrl();
  const dagId = query["dag"];

  const list = (
    <ListView
      filterStatus={filterStatus}
      filterMode={filterMode}
      filterBucket={filterBucket}
      filterRepo={filterRepo}
      onFilterRepo={onFilterRepo}
    />
  );

  switch (view) {
    case "list":
      return list;
    case "kanban":
      return (
        <KanbanView
          filterStatus={filterStatus}
          filterMode={filterMode}
          filterRepo={filterRepo}
          onFilterRepo={onFilterRepo}
        />
      );
    case "dag":
      return <DagCanvasView sessionSlug={sessionSlug} dagId={dagId} />;
    case "ship":
      return <ShipPipelineView sessionSlug={sessionSlug} />;
    case "new":
      return api ? <NewSessionView api={api} filterRepo={filterRepo} /> : list;
    case "doctor":
      return api ? <DoctorView api={api} /> : list;
    case "loops":
      return api ? <LoopsView api={api} /> : list;
    case "inbox":
      return api ? <InboxView api={api} /> : list;
    default:
      return list;
  }
}
