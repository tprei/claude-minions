import { useState, useEffect, useMemo, type ReactElement } from "react";
import { AppLayout } from "./views/layout.js";
import { Header } from "./views/header.js";
import { Sidebar } from "./views/sidebar.js";
import { Spinner } from "./components/Spinner.js";
import { Sheet } from "./components/Sheet.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { buildActions, type PaletteSessionRef } from "./components/CommandPalette.actions.js";
import { parseUrl, type ViewKind } from "./routing/parseUrl.js";
import { subscribeUrlChanges, setUrlState } from "./routing/urlState.js";
import { useConnectionStore } from "./connections/store.js";
import { useRootStore } from "./store/root.js";
import { useSessionStore, EMPTY_SESSIONS } from "./store/sessionStore.js";
import { apiFetch } from "./transport/rest.js";
import type { Connection } from "./connections/store.js";
import { ViewSwitcher } from "./views/ViewSwitcher.js";
import { AuditDrawer } from "./views/auditDrawer.js";
import { ChatSurface } from "./chat/ChatSurface.js";
import { MemoryDrawer } from "./memory/Drawer.js";
import { RuntimeDrawer } from "./runtime/Drawer.js";
import { ResourceIndicator } from "./resource/Indicator.js";
import { LoopsDrawer } from "./views/loopsDrawer.js";
import { VariantsDrawer } from "./views/variantsDrawer.js";
import { EntrypointsDrawer } from "./views/entrypointsDrawer.js";
import { initInstallPrompt } from "./pwa/install.js";
import { initOfflineDetection } from "./pwa/offline.js";
import { OfflineBanner } from "./pwa/OfflineBanner.js";
import { InstallButton } from "./pwa/InstallButton.js";
import { registerServiceWorker } from "./pwa/sw.js";
import { UpdateBanner } from "./pwa/UpdateBanner.js";
import type { SessionBucket } from "@minions/shared";

type FilterStatus = "all" | "running" | "waiting_input" | "completed" | "failed" | "attention";
type FilterMode = "all" | "task" | "ship" | "dag-task" | "loop";
type FilterBucket = "all" | SessionBucket;

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
  const [filterBucket, setFilterBucket] = useState<FilterBucket>("all");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [loopsOpen, setLoopsOpen] = useState(false);
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [entrypointsOpen, setEntrypointsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const hydrated = useConnectionStore(s => s._hydrated);
  const activeConn = useRootStore(s => s.getActiveConnection());
  const activeId = useConnectionStore(s => s.activeId);
  const sessionsMap = useSessionStore(s => (activeId ? s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS : EMPTY_SESSIONS));

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
    for (const s of sessionsMap.values()) {
      arr.push({ slug: s.slug, title: s.title, status: s.status });
    }
    arr.sort((a, b) => a.title.localeCompare(b.title));
    return arr;
  }, [sessionsMap]);

  const paletteActions = useMemo(() => buildActions({
    activeId,
    openMemory: () => setMemoryOpen(true),
    openRuntime: () => setRuntimeOpen(true),
    openLoops: () => setLoopsOpen(true),
    openAudit: () => setAuditOpen(true),
    openVariants: () => setVariantsOpen(true),
    openEntrypoints: () => setEntrypointsOpen(true),
    sessions: paletteSessions,
  }), [activeId, paletteSessions]);

  const { view, sessionSlug } = urlState;

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
        header={<Header api={api} installPrompt={<InstallButton />} resourceIndicator={activeConn ? <ResourceIndicator connId={activeConn.id} /> : undefined} />}
        sidebar={({ closeMobile }) => (
          <Sidebar
            currentView={view as ViewKind}
            filterStatus={filterStatus}
            filterMode={filterMode}
            filterBucket={filterBucket}
            onFilterStatus={setFilterStatus}
            onFilterMode={setFilterMode}
            onFilterBucket={setFilterBucket}
            onOpenAudit={() => setAuditOpen(true)}
            onOpenMemory={() => setMemoryOpen(true)}
            onOpenRuntime={() => setRuntimeOpen(true)}
            onOpenLoops={() => setLoopsOpen(true)}
            onOpenDoctor={() => {
              if (!activeId) return;
              setUrlState({ connectionId: activeId, view: "doctor" });
              globalThis.location.hash = "cleanup";
              closeMobile();
            }}
            onNavigate={closeMobile}
          />
        )}
        main={
          <ViewSwitcher
            view={view as ViewKind}
            filterStatus={filterStatus}
            filterMode={filterMode}
            filterBucket={filterBucket}
            sessionSlug={sessionSlug ?? null}
            api={api}
          />
        }
        chatSurface={
          activeConn ? (
            <ChatSurface
              sessionSlug={sessionSlug ?? null}
              primary={Boolean(sessionSlug)}
              onOpenConfig={() => setRuntimeOpen(true)}
              onOpenHelp={() => setPaletteOpen(true)}
            />
          ) : undefined
        }
        isSessionOpen={Boolean(sessionSlug)}
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

      {loopsOpen && api && (
        <Sheet open={loopsOpen} onClose={() => setLoopsOpen(false)} side="right" title="Loops">
          <LoopsDrawer api={api} onClose={() => setLoopsOpen(false)} />
        </Sheet>
      )}

      {auditOpen && (
        <Sheet open={auditOpen} onClose={() => setAuditOpen(false)} side="right" title="Audit">
          <AuditDrawer onClose={() => setAuditOpen(false)} />
        </Sheet>
      )}

      {variantsOpen && api && (
        <Sheet open={variantsOpen} onClose={() => setVariantsOpen(false)} side="right" title="Variants">
          <VariantsDrawer api={api} onClose={() => setVariantsOpen(false)} />
        </Sheet>
      )}

      {entrypointsOpen && api && (
        <Sheet open={entrypointsOpen} onClose={() => setEntrypointsOpen(false)} side="right" title="Entrypoints">
          <EntrypointsDrawer api={api} onClose={() => setEntrypointsOpen(false)} />
        </Sheet>
      )}

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
