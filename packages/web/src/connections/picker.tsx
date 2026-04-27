import { useState, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore, type Connection } from "./store.js";
import { AddDialog } from "./addDialog.js";
import { cx } from "../util/classnames.js";

interface PickerProps {
  onClose: () => void;
}

function ConnectionRow({ conn, active, onSelect }: { conn: Connection; active: boolean; onSelect: () => void }): ReactElement {
  return (
    <button
      onClick={onSelect}
      className={cx(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left",
        active
          ? "bg-accent/20 text-zinc-100"
          : "hover:bg-bg-elev text-zinc-300",
      )}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: conn.color }}
        aria-hidden="true"
      />
      <span className="flex-1 truncate">{conn.label}</span>
      <span className="text-xs text-zinc-600 truncate max-w-[120px]">{conn.baseUrl}</span>
      {active && <span className="text-accent text-xs">●</span>}
    </button>
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
        <p className="text-xs text-zinc-500 font-medium px-3 py-1.5">Connections</p>
        {connections.length === 0 && (
          <p className="text-xs text-zinc-600 px-3 py-2">No connections yet.</p>
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
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-100 hover:bg-bg-elev transition-colors"
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
