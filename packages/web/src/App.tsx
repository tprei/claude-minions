import { useState, useEffect, useMemo, useCallback, type ReactElement } from "react";
import { AppLayout } from "./views/layout.js";
import { Header } from "./views/header.js";
import { Sidebar } from "./views/sidebar.js";
import { Spinner } from "./components/Spinner.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { buildActions, type PaletteSessionRef } from "./components/CommandPalette.actions.js";
import { parseUrl, type ViewKind } from "./routing/parseUrl.js";
import { subscribeUrlChanges, setUrlState, replaceUrlState } from "./routing/urlState.js";
import { useConnectionStore } from "./connections/store.js";
import { useRootStore } from "./store/root.js";
import { useWorkflowStore, EMPTY_WORKFLOWS } from "./store/workflowStore.js";
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
  const connections = useConnectionStore(s => s.connections);
  const activeConn = useRootStore(s => s.getActiveConnection());
  const activeId = useConnectionStore(s => s.activeId);
  const workflowsMap = useWorkflowStore(s => (activeId ? s.byConnection.get(activeId) ?? EMPTY_WORKFLOWS : EMPTY_WORKFLOWS));

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
    sessions: paletteSessions,
  }), [activeId, paletteSessions]);

  const { view, sessionSlug } = urlState;
  const filterRepo = urlState.query["repo"] ?? null;
  const routeConnectionIsUnknown = useMemo(() => (
    urlState.connectionId !== null &&
    !connections.some((conn) => conn.id === urlState.connectionId)
  ), [urlState.connectionId, connections]);

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

  const api = useMemo(() => activeConn ? makeApi(activeConn) : null, [activeConn]);
  const pushWorkflowId = useMemo(() => {
    if (!sessionSlug) return null;
    if (workflowsMap.has(sessionSlug)) return sessionSlug;
    for (const workflow of workflowsMap.values()) {
      if (workflow.graph[sessionSlug]) return workflow.id;
    }
    return null;
  }, [sessionSlug, workflowsMap]);

  useEffect(() => {
    try { initInstallPrompt(); } catch (err) { console.error("initInstallPrompt failed", err); }
    try { initOfflineDetection(); } catch (err) { console.error("initOfflineDetection failed", err); }
    try { registerServiceWorker(); } catch (err) { console.error("registerServiceWorker failed", err); }
  }, []);

  useEffect(() => {
    if (!hydrated || !routeConnectionIsUnknown) return;
    replaceUrlState({
      connectionId: activeId,
      view: urlState.view,
      sessionSlug: urlState.sessionSlug ?? null,
      query: urlState.query,
    });
  }, [hydrated, routeConnectionIsUnknown, activeId, urlState]);

  useEffect(() => {
    if (!hydrated) return;
    const routeConnId = urlState.connectionId;
    if (!routeConnId || routeConnId === activeId) return;
    const hasRouteConnection = connections.some((conn) => conn.id === routeConnId);
    if (hasRouteConnection) {
      useConnectionStore.getState().setActive(routeConnId);
    }
  }, [hydrated, urlState.connectionId, activeId, connections]);

  if (!hydrated || routeConnectionIsUnknown) {
    return <LoadingScreen />;
  }

  return (
    <>
      <AppLayout
        header={<Header conn={activeConn} pushWorkflowId={pushWorkflowId} installPrompt={<InstallButton />} />}
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
