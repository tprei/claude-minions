import { useState, type FormEvent, type ReactElement } from "react";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/Button.js";
import { useConnectionStore } from "./store.js";
import { getVersion } from "../transport/rest.js";

const PRESET_COLORS = ["#7c5cff", "#34d399", "#f59e0b", "#f87171", "#60a5fa", "#e879f9"];

interface AddDialogProps {
  onClose: () => void;
  onAdded: (id: string) => void;
}

export function AddDialog({ onClose, onAdded }: AddDialogProps): ReactElement {
  const add = useConnectionStore(s => s.add);

  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3000");
  const [token, setToken] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0] ?? "#7c5cff");
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setValidating(true);

    const trimmedUrl = baseUrl.trim().replace(/\/$/, "");
    const trimmedToken = token.trim();
    const trimmedLabel = label.trim() || trimmedUrl;

    try {
      const conn = { id: "tmp", label: trimmedLabel, baseUrl: trimmedUrl, token: trimmedToken, color };
      await getVersion(conn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to connect";
      setError(`Validation failed: ${msg}`);
      setValidating(false);
      return;
    }

    const full = add({ label: trimmedLabel, baseUrl: trimmedUrl, token: trimmedToken, color });
    setValidating(false);
    onAdded(full.id);
  }

  return (
    <Modal open title="Add connection" onClose={onClose} className="max-w-sm">
      <form onSubmit={e => void handleSubmit(e)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-400">Label</label>
          <input
            className="input"
            placeholder="My engine"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-400">Base URL</label>
          <input
            className="input"
            required
            placeholder="http://localhost:3000"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-400">Bearer token</label>
          <input
            className="input"
            type="password"
            required
            placeholder="secret"
            value={token}
            onChange={e => setToken(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-400">Color</label>
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

        {error && (
          <p className="text-xs text-err">{error}</p>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={validating}>
            {validating ? "Checking…" : "Add"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
