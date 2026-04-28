import { useState, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "../connections/store.js";
import { ConnectionPicker } from "../connections/picker.js";
import { useVersionStore } from "../store/version.js";
import { useFeature } from "../hooks/useFeature.js";
import { useTheme } from "../hooks/useTheme.js";
import { cx } from "../util/classnames.js";
import { sseStatusStore, type SseStatus } from "../transport/sseStatus.js";
import { registerPush, unregisterPush, usePushPermission } from "../pwa/push.js";

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

function ThemeToggle(): ReactElement {
  const { effective, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="w-8 h-8 flex items-center justify-center rounded-lg text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors"
      aria-label={`Switch to ${effective === "dark" ? "light" : "dark"} mode`}
    >
      {effective === "dark" ? (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="5" />
          <path strokeLinecap="round" d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      )}
    </button>
  );
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

      {resourceIndicator && (
        <div className="flex-shrink-0">{resourceIndicator}</div>
      )}

      {installPrompt && (
        <div className="flex-shrink-0">{installPrompt}</div>
      )}

      {(resourceIndicator || installPrompt) && (
        <div className="h-5 w-px bg-border mx-1 flex-shrink-0" aria-hidden="true" />
      )}

      {api && <PushToggle api={api} />}

      <ThemeToggle />
    </div>
  );
}
