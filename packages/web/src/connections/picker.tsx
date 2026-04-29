import { useState, useSyncExternalStore, type FormEvent, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore, type Connection } from "./store.js";
import { AddDialog } from "./addDialog.js";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/Button.js";
import { QrImportModal } from "../pwa/QrImportModal.js";
import { cx } from "../util/classnames.js";
import { sseStatusStore, type SseStatus } from "../transport/sseStatus.js";

interface PickerProps {
  onClose: () => void;
}

interface QrCandidate {
  label: string;
  baseUrl: string;
  token: string;
  color: string;
}

const PRESET_COLORS = ["#7c5cff", "#34d399", "#f59e0b", "#f87171", "#60a5fa", "#e879f9"];

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

function QrConfirmDialog({
  candidate,
  onAdded,
  onClose,
}: {
  candidate: QrCandidate;
  onAdded: (id: string) => void;
  onClose: () => void;
}): ReactElement {
  const add = useConnectionStore(s => s.add);
  const [label, setLabel] = useState(candidate.label);
  const [baseUrl, setBaseUrl] = useState(candidate.baseUrl);
  const [color, setColor] = useState(candidate.color || PRESET_COLORS[0]!);

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    const trimmedUrl = baseUrl.trim().replace(/\/$/, "");
    const trimmedLabel = label.trim() || trimmedUrl;
    const conn = add({ label: trimmedLabel, baseUrl: trimmedUrl, token: candidate.token, color });
    onAdded(conn.id);
  }

  return (
    <Modal open title="Confirm scanned connection" onClose={onClose} className="max-w-sm">
      <form
        data-testid="qr-confirm-form"
        onSubmit={handleSubmit}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-1">
          <label className="text-xs text-fg-muted">Label</label>
          <input
            data-testid="qr-confirm-label"
            className="input"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-fg-muted">Base URL</label>
          <input
            data-testid="qr-confirm-base-url"
            className="input"
            required
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-fg-muted">Color</label>
          <div className="flex gap-2">
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  background: c,
                  borderColor: color === c ? "white" : "transparent",
                }}
                aria-label={c}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">Add</Button>
        </div>
      </form>
    </Modal>
  );
}

export function ConnectionPicker({ onClose }: PickerProps): ReactElement {
  const { connections, activeId, setActive } = useConnectionStore(useShallow(s => ({
    connections: s.connections,
    activeId: s.activeId,
    setActive: s.setActive,
  })));
  const [showAdd, setShowAdd] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrCandidate, setQrCandidate] = useState<QrCandidate | null>(null);

  function handleSelect(id: string): void {
    setActive(id);
    onClose();
  }

  function handleQrImport(payload: { label: string; baseUrl: string; token: string; color?: string }): void {
    setShowQr(false);
    setQrCandidate({
      label: payload.label,
      baseUrl: payload.baseUrl,
      token: payload.token,
      color: payload.color ?? PRESET_COLORS[0]!,
    });
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
        <div className="border-t border-border mt-1 pt-1 flex flex-col">
          <button
            data-testid="picker-add-connection"
            onClick={() => setShowAdd(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors"
          >
            <span className="text-accent">+</span>
            Add connection
          </button>
          <button
            data-testid="picker-scan-qr"
            onClick={() => setShowQr(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors"
          >
            <span className="text-accent" aria-hidden="true">▦</span>
            Scan QR
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

      {showQr && (
        <QrImportModal
          onImport={handleQrImport}
          onClose={() => setShowQr(false)}
        />
      )}

      {qrCandidate && (
        <QrConfirmDialog
          candidate={qrCandidate}
          onClose={() => setQrCandidate(null)}
          onAdded={id => {
            setActive(id);
            setQrCandidate(null);
            onClose();
          }}
        />
      )}
    </>
  );
}
