import { useState, useEffect, type ReactElement } from "react";
import { AppLayout } from "./views/layout.js";
import { Header } from "./views/header.js";
import { Sidebar } from "./views/sidebar.js";
import { Spinner } from "./components/Spinner.js";
import { Sheet } from "./components/Sheet.js";
import { parseUrl, type ViewKind } from "./routing/parseUrl.js";
import { subscribeUrlChanges } from "./routing/urlState.js";
import { useConnectionStore } from "./connections/store.js";
import { useRootStore } from "./store/root.js";
import { apiFetch } from "./transport/rest.js";
import type { Connection } from "./connections/store.js";
import { ViewSwitcher } from "./views/ViewSwitcher.js";
import { ChatSurface } from "./chat/ChatSurface.js";
import { MemoryDrawer } from "./memory/Drawer.js";
import { RuntimeDrawer } from "./runtime/Drawer.js";
import { ResourcePanel } from "./resource/Panel.js";
import { useResourceStore } from "./store/resourceStore.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";

function makeApi(conn: Connection) {
  return {
    async get(path: string): Promise<unknown> {
      return apiFetch(conn, path);
    },
    async post(path: string, body: unknown): Promise<unknown> {
      return apiFetch(conn, path, { method: "POST", body: JSON.stringify(body) });
    },
    async patch(path: string, body: unknown): Promise<unknown> {
      return apiFetch(conn, path, { method: "PATCH", body: JSON.stringify(body) });
    },
    async del(path: string): Promise<unknown> {
      return apiFetch(conn, path, { method: "DELETE" });
    },
  };
}

function LoadingScreen(): ReactElement {
  return (
    <div className="h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

export function App(): ReactElement {
  const [urlState, setUrlStateLocal] = useState(() => parseUrl());
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [loopsOpen, setLoopsOpen] = useState(false);

  const hydrated = useConnectionStore(s => s._hydrated);
  const activeConn = useRootStore(s => s.getActiveConnection());
  const resourceSnapshot = useResourceStore(s => s.snapshot);

  useEffect(() => {
    const unsub = subscribeUrlChanges(() => {
      setUrlStateLocal(parseUrl());
    });
    return unsub;
  }, []);

  const { view, sessionSlug } = urlState;

  if (!hydrated) {
    return <LoadingScreen />;
  }

  const api = activeConn ? makeApi(activeConn) : null;

  return (
    <>
      <AppLayout
        header={<Header />}
        sidebar={
          <Sidebar
            currentView={view as ViewKind}
            filterStatus={filterStatus}
            filterMode={filterMode}
            onFilterStatus={setFilterStatus}
            onFilterMode={setFilterMode}
            onOpenAudit={() => setAuditOpen(true)}
            onOpenMemory={() => setMemoryOpen(true)}
            onOpenRuntime={() => setRuntimeOpen(true)}
            onOpenLoops={() => setLoopsOpen(true)}
          />
        }
        main={
          <ViewSwitcher
            view={view as ViewKind}
            filterStatus={filterStatus}
            filterMode={filterMode}
            sessionSlug={sessionSlug ?? null}
          />
        }
        chatSurface={
          activeConn ? (
            <ChatSurface sessionSlug={sessionSlug ?? null} />
          ) : undefined
        }
      />

      {memoryOpen && api && (
        <Sheet open={memoryOpen} onClose={() => setMemoryOpen(false)} side="right" title="Memory">
          <MemoryDrawer api={api} onClose={() => setMemoryOpen(false)} />
        </Sheet>
      )}

      {runtimeOpen && api && (
        <Sheet open={runtimeOpen} onClose={() => setRuntimeOpen(false)} side="right" title="Runtime Config">
          <RuntimeDrawer api={api} onClose={() => setRuntimeOpen(false)} />
        </Sheet>
      )}

      {loopsOpen && resourceSnapshot && (
        <Sheet open={loopsOpen} onClose={() => setLoopsOpen(false)} side="right" title="Resources">
          <ResourcePanel snapshot={resourceSnapshot} lagHistory={[]} />
        </Sheet>
      )}

      {auditOpen && (
        <Sheet open={auditOpen} onClose={() => setAuditOpen(false)} side="right" title="Audit">
          <div className="p-4 text-sm text-zinc-400">Audit drawer — provided by Web C</div>
        </Sheet>
      )}
    </>
  );
}
