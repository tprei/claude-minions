import { useState, useEffect, useMemo, useCallback, type ReactElement } from "react";
import type { Workflow } from "@minions/engine-next";
import { AppLayout } from "./views/layout.js";
import { Header } from "./views/header.js";
import { Sidebar } from "./views/sidebar.js";
import { Spinner } from "./components/Spinner.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { buildActions, type PaletteSessionRef } from "./components/CommandPalette.actions.js";
import { parseUrl, type ViewKind } from "./routing/parseUrl.js";
import { subscribeUrlChanges, setUrlState } from "./routing/urlState.js";
import { useConnectionStore } from "./connections/store.js";
import { useRootStore } from "./store/root.js";
import { useWorkflowStore } from "./store/workflowStore.js";
import { apiFetch } from "./transport/rest.js";
import type { Connection } from "./connections/store.js";
import { ViewSwitcher } from "./views/ViewSwitcher.js";
import { ChatSurface } from "./chat/ChatSurface.js";
import { initInstallPrompt } from "./pwa/install.js";
import { initOfflineDetection } from "./pwa/offline.js";
import { OfflineBanner } from "./pwa/OfflineBanner.js";
import { InstallButton } from "./pwa/InstallButton.js";
import { registerServiceWorker } from "./pwa/sw.js";
import { UpdateBanner } from "./pwa/UpdateBanner.js";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed";
type FilterMode = "all" | "task" | "dag-task";

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
    async del(path: string, body?: unknown): Promise<unknown> {
      return apiFetch(conn, path, {
        method: "DELETE",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
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
  const [paletteOpen, setPaletteOpen] = useState(false);

  const hydrated = useConnectionStore(s => s._hydrated);
  const activeConn = useRootStore(s => s.getActiveConnection());
  const activeId = useConnectionStore(s => s.activeId);
  const workflowsMap = useWorkflowStore(s => (activeId ? s.byConnection.get(activeId) ?? new Map<string, Workflow>() : new Map<string, Workflow>()));

  useEffect(() => {
    const unsub = subscribeUrlChanges(() => {
      setUrlStateLocal(parseUrl());
    });
    return unsub;
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const paletteSessions = useMemo<PaletteSessionRef[]>(() => {
    const arr: PaletteSessionRef[] = [];
    for (const workflow of workflowsMap.values()) {
      const firstTask = Object.values(workflow.graph)[0];
      arr.push({
        slug: workflow.id,
        title: firstTask?.title ?? workflow.id,
        status: workflow.status,
      });
    }
    arr.sort((a, b) => a.title.localeCompare(b.title));
    return arr;
  }, [workflowsMap]);

  const paletteActions = useMemo(() => buildActions({
    activeId,
    openMemory: undefined,
    openRuntime: undefined,
    openLoops: undefined,
    openAudit: undefined,
    openVariants: undefined,
    openEntrypoints: undefined,
    sessions: paletteSessions,
  }), [activeId, paletteSessions]);

  const { view, sessionSlug } = urlState;
  const filterRepo = urlState.query["repo"] ?? null;

  const setFilterRepo = useCallback((repoId: string | null) => {
    const nextQuery = { ...urlState.query };
    if (repoId === null) delete nextQuery["repo"];
    else nextQuery["repo"] = repoId;
    setUrlState({
      connectionId: urlState.connectionId,
      view: urlState.view,
      sessionSlug: urlState.sessionSlug ?? null,
      query: nextQuery,
    });
  }, [urlState]);

  if (!hydrated) {
    return <LoadingScreen />;
  }

  const api = activeConn ? makeApi(activeConn) : null;

  useEffect(() => {
    try { initInstallPrompt(); } catch (err) { console.error("initInstallPrompt failed", err); }
    try { initOfflineDetection(); } catch (err) { console.error("initOfflineDetection failed", err); }
    try { registerServiceWorker(); } catch (err) { console.error("registerServiceWorker failed", err); }
  }, []);

  return (
    <>
      <AppLayout
        header={<Header api={api} installPrompt={<InstallButton />} />}
        sidebar={({ closeMobile }) => (
          <Sidebar
            currentView={view as ViewKind}
            filterStatus={filterStatus}
            filterMode={filterMode}
            onFilterStatus={setFilterStatus}
            onFilterMode={setFilterMode}
            onNavigate={closeMobile}
          />
        )}
        main={
          <ViewSwitcher
            view={view as ViewKind}
            filterStatus={filterStatus}
            filterMode={filterMode}
            filterRepo={filterRepo}
            onFilterRepo={setFilterRepo}
            sessionSlug={sessionSlug ?? null}
            api={api}
          />
        }
        chatSurface={
          activeConn ? (
            <ChatSurface
              sessionSlug={sessionSlug ?? null}
              primary={Boolean(sessionSlug)}
            />
          ) : undefined
        }
        isSessionOpen={Boolean(sessionSlug)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />

      <OfflineBanner />

      <UpdateBanner />
    </>
  );
}
