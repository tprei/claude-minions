import { useState, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "../connections/store.js";
import { ConnectionPicker } from "../connections/picker.js";
import { useVersionStore } from "../store/version.js";
import { useFeature } from "../hooks/useFeature.js";
import { cx } from "../util/classnames.js";
import { sseStatusStore, type SseStatus } from "../transport/sseStatus.js";
import { registerPush, unregisterPush, usePushPermission } from "../pwa/push.js";
import { ThemeToggle } from "../pwa/ThemeToggle.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";

interface PushApi {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string) => Promise<unknown>;
}

function PushToggle({ api }: { api: PushApi }): ReactElement | null {
  const permission = usePushPermission();
  const [subscribed, setSubscribed] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (permission !== "granted") {
      setSubscribed(false);
      return;
    }
    let cancelled = false;
    void navigator.serviceWorker?.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => { if (!cancelled) setSubscribed(sub !== null); })
      .catch(() => { if (!cancelled) setSubscribed(false); });
    return () => { cancelled = true; };
  }, [permission]);

  if (permission === "unsupported") return null;
  const isSubscribed = permission === "granted" && subscribed;

  async function toggle(): Promise<void> {
    setBusy(true);
    try {
      if (isSubscribed) {
        await unregisterPush(api);
        setSubscribed(false);
      } else {
        const ok = await registerPush(api);
        setSubscribed(ok);
      }
    } catch (err) {
      console.error("push toggle failed", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      className="w-8 h-8 flex items-center justify-center rounded-lg text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors disabled:opacity-50"
      aria-label={isSubscribed ? "Disable push notifications" : "Enable push notifications"}
      aria-pressed={isSubscribed}
      title={isSubscribed ? "Push notifications on" : "Push notifications off"}
    >
      {isSubscribed ? "🔔" : "🔕"}
    </button>
  );
}

function SseStatusPill({ connId }: { connId: string }): ReactElement | null {
  const status = useSyncExternalStore<SseStatus | undefined>(
    sseStatusStore.subscribe,
    () => sseStatusStore.get(connId),
    () => undefined,
  );
  if (!status || status === "open") return null;
  const reconnecting = status === "reconnecting";
  return (
    <span
      role="status"
      aria-live="polite"
      className={cx(
        "pill border border-border bg-bg-elev text-fg-muted",
        reconnecting && "animate-pulse",
      )}
    >
      {reconnecting ? "reconnecting…" : "connecting…"}
    </span>
  );
}

interface HeaderProps {
  resourceIndicator?: ReactNode;
  installPrompt?: ReactNode;
  api?: PushApi | null;
}

function VersionPopover({ connId }: { connId: string }): ReactElement | null {
  const info = useVersionStore(s => s.byConnection.get(connId));
  const [open, setOpen] = useState(false);
  const hasResources = useFeature("resources");

  if (!info) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-xs text-fg-subtle hover:text-fg-muted font-mono transition-colors px-1"
      >
        v{info.libraryVersion}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 top-8 z-40 card p-3 min-w-[220px] shadow-2xl">
            <p className="text-xs font-medium text-fg-muted mb-2">Engine info</p>
            <dl className="text-xs space-y-1">
              <div className="flex justify-between gap-4">
                <dt className="text-fg-subtle">API version</dt>
                <dd className="font-mono text-fg-muted">{info.apiVersion}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-fg-subtle">Provider</dt>
                <dd className="text-fg-muted">{info.provider}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-fg-subtle">Resources</dt>
                <dd className={hasResources ? "text-ok" : "text-fg-subtle"}>{hasResources ? "enabled" : "disabled"}</dd>
              </div>
            </dl>
            <p className="text-xs text-fg-subtle mt-2 font-medium">Features</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {info.features.map(f => (
                <span key={f} className="pill bg-accent/10 text-accent border border-accent/20">{f}</span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function Header({ resourceIndicator, installPrompt, api }: HeaderProps): ReactElement {
  const { connections, activeId } = useConnectionStore(useShallow(s => ({
    connections: s.connections,
    activeId: s.activeId,
  })));
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeConn = connections.find(c => c.id === activeId);

  return (
    <div className="flex items-center gap-2 px-3 h-full min-w-0">
      <div className="relative">
        <button
          onClick={() => setPickerOpen(v => !v)}
          className={cx(
            "pill border border-border bg-bg-soft hover:bg-bg-elev transition-colors cursor-pointer gap-2 pr-3",
            pickerOpen && "border-accent/60",
          )}
        >
          {activeConn ? (
            <>
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: activeConn.color }}
                aria-hidden="true"
              />
              <span className="text-fg-muted max-w-[140px] truncate">{activeConn.label}</span>
            </>
          ) : (
            <span className="text-fg-subtle">No connection</span>
          )}
          <svg className="w-3 h-3 text-fg-subtle ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {pickerOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setPickerOpen(false)} aria-hidden="true" />
            <div className="absolute left-0 top-8 z-40">
              <ConnectionPicker onClose={() => setPickerOpen(false)} />
            </div>
          </>
        )}
      </div>

      {activeId && <VersionPopover connId={activeId} />}

      {activeId && <SseStatusPill connId={activeId} />}

      <div className="flex-1 min-w-0" />

      <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
        {resourceIndicator && <div className="flex-shrink-0">{resourceIndicator}</div>}
        {installPrompt && <div className="flex-shrink-0">{installPrompt}</div>}
        {(resourceIndicator || installPrompt) && (
          <div className="h-5 w-px bg-border mx-1 flex-shrink-0" aria-hidden="true" />
        )}
        {api && <PushToggle api={api} />}
        <ThemeToggle />
      </div>

      {activeId && <MobileNewSessionButton activeId={activeId} />}

      <MobileActions
        resourceIndicator={resourceIndicator}
        installPrompt={installPrompt}
        api={api ?? null}
      />
    </div>
  );
}

function MobileNewSessionButton({ activeId }: { activeId: string }): ReactElement {
  function openNew(): void {
    const { sessionSlug, query } = parseUrl();
    setUrlState({ connectionId: activeId, view: "new", sessionSlug, query });
  }
  return (
    <button
      type="button"
      data-testid="header-new-session"
      onClick={openNew}
      aria-label="New session"
      title="New session"
      className="sm:hidden w-8 h-8 flex items-center justify-center rounded-lg bg-accent text-white hover:bg-accent-soft transition-colors flex-shrink-0"
    >
      <span className="text-base leading-none">+</span>
    </button>
  );
}

interface MobileActionsProps {
  resourceIndicator?: ReactNode;
  installPrompt?: ReactNode;
  api: PushApi | null;
}

function MobileActions({ resourceIndicator, installPrompt, api }: MobileActionsProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="sm:hidden relative flex-shrink-0">
      <button
        type="button"
        data-testid="header-more"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="More actions"
        className="w-8 h-8 flex items-center justify-center rounded-lg text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h.01M12 12h.01M19 12h.01" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            data-testid="header-mobile-actions"
            className="absolute right-0 top-9 z-40 card p-2 flex flex-col items-stretch gap-1 shadow-2xl min-w-[180px]"
          >
            {resourceIndicator && (
              <div className="flex items-center gap-2 px-2 py-1">
                {resourceIndicator}
                <span className="text-xs text-fg-muted">Resources</span>
              </div>
            )}
            {installPrompt && <div className="px-2 py-1">{installPrompt}</div>}
            {api && (
              <div className="flex items-center gap-2 px-2 py-1">
                <PushToggle api={api} />
                <span className="text-xs text-fg-muted">Push</span>
              </div>
            )}
            <div className="flex items-center gap-2 px-2 py-1">
              <ThemeToggle />
              <span className="text-xs text-fg-muted">Theme</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
