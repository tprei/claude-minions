import { useState, useSyncExternalStore, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore, type Connection } from "./store.js";
import { AddDialog } from "./addDialog.js";
import { cx } from "../util/classnames.js";
import { sseStatusStore, type SseStatus } from "../transport/sseStatus.js";

interface PickerProps {
  onClose: () => void;
}

const HEALTH_DOT: Record<SseStatus, string> = {
  open: "bg-emerald-500",
  connecting: "bg-amber-400 animate-pulse",
  reconnecting: "bg-amber-500 animate-pulse",
  down: "bg-red-500",
};

const HEALTH_LABEL: Record<SseStatus, string> = {
  open: "live",
  connecting: "connecting",
  reconnecting: "reconnecting",
  down: "down",
};

function useSseStatus(connectionId: string): SseStatus | undefined {
  return useSyncExternalStore(
    sseStatusStore.subscribe,
    () => sseStatusStore.get(connectionId),
    () => undefined,
  );
}

function ConnectionRow({ conn, active, onSelect }: { conn: Connection; active: boolean; onSelect: () => void }): ReactElement {
  const status = useSseStatus(conn.id);
  const dot = status ? HEALTH_DOT[status] : "bg-fg-subtle/40";
  const label = status ? HEALTH_LABEL[status] : "idle";
  const showReconnect = status === "down" || status === "reconnecting";

  return (
    <div
      className={cx(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
        active ? "bg-accent/20 text-fg" : "hover:bg-bg-elev text-fg-muted",
      )}
    >
      <button onClick={onSelect} className="flex-1 flex items-center gap-2 min-w-0 text-left">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: conn.color }}
          aria-hidden="true"
        />
        <span className="flex-1 truncate">{conn.label}</span>
        <span className="text-xs text-fg-subtle truncate max-w-[110px]">{conn.baseUrl}</span>
      </button>
      <span
        className={cx("w-1.5 h-1.5 rounded-full flex-shrink-0", dot)}
        aria-label={`SSE ${label}`}
        title={`SSE ${label}`}
      />
      {showReconnect && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            sseStatusStore.forceReconnect(conn.id);
          }}
          className="text-[10px] px-1.5 py-0.5 rounded bg-bg-elev text-fg-muted hover:text-fg hover:bg-bg-soft border border-border"
          title="Force reconnect"
        >
          ↻
        </button>
      )}
      {active && <span className="text-accent text-xs">●</span>}
    </div>
  );
}

export function ConnectionPicker({ onClose }: PickerProps): ReactElement {
  const { connections, activeId, setActive } = useConnectionStore(useShallow(s => ({
    connections: s.connections,
    activeId: s.activeId,
    setActive: s.setActive,
  })));
  const [showAdd, setShowAdd] = useState(false);

  function handleSelect(id: string): void {
    setActive(id);
    onClose();
  }

  return (
    <>
      <div className="card p-2 min-w-[260px] shadow-2xl">
        <p className="text-xs text-fg-subtle font-medium px-3 py-1.5">Connections</p>
        {connections.length === 0 && (
          <p className="text-xs text-fg-subtle px-3 py-2">No connections yet.</p>
        )}
        {connections.map(conn => (
          <ConnectionRow
            key={conn.id}
            conn={conn}
            active={conn.id === activeId}
            onSelect={() => handleSelect(conn.id)}
          />
        ))}
        <div className="border-t border-border mt-1 pt-1">
          <button
            onClick={() => setShowAdd(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors"
          >
            <span className="text-accent">+</span>
            Add connection
          </button>
        </div>
      </div>

      {showAdd && (
        <AddDialog
          onClose={() => setShowAdd(false)}
          onAdded={id => {
            setActive(id);
            setShowAdd(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
