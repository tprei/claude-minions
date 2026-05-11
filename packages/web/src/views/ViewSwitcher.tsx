import type { ViewKind } from "../routing/parseUrl.js";
import { parseUrl } from "../routing/parseUrl.js";
import { ListView } from "./list.js";
import { DagCanvasView } from "./dagCanvas.js";
import { NewSessionView } from "./newSession.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "dag-task";

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
  filterRepo: string | null;
  onFilterRepo: (repoId: string | null) => void;
  sessionSlug?: string | null;
  api?: ApiClient | null;
}

export function ViewSwitcher({ view, filterStatus, filterMode, filterRepo, onFilterRepo, sessionSlug, api }: Props) {
  const { query } = parseUrl();
  const dagId = query["dag"];

  const list = (
    <ListView
      filterStatus={filterStatus}
      filterMode={filterMode}
      filterRepo={filterRepo}
      onFilterRepo={onFilterRepo}
    />
  );

  switch (view) {
    case "list":
      return list;
    case "dag":
      return <DagCanvasView sessionSlug={sessionSlug} dagId={dagId} />;
    case "new":
      return api ? <NewSessionView api={api} filterRepo={filterRepo} /> : list;
    default:
      return list;
  }
}
