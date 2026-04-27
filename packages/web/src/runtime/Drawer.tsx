import { useState, useEffect, useCallback } from "react";
import type { RuntimeConfigResponse, RuntimeOverrides } from "@minions/shared";
import { AutoForm } from "./autoForm.js";

interface Props {
  api: {
    get: (path: string) => Promise<unknown>;
    patch: (path: string, body: unknown) => Promise<unknown>;
  };
  onClose: () => void;
}

export function RuntimeDrawer({ api, onClose }: Props) {
  const [config, setConfig] = useState<RuntimeConfigResponse | null>(null);
  const [draft, setDraft] = useState<RuntimeOverrides>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/api/config/runtime") as RuntimeConfigResponse;
      setConfig(res);
      setDraft(res.values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  function handleChange(key: string, value: unknown) {
    setDraft(d => ({ ...d, [key]: value }));
  }

  function handleReset(key: string) {
    if (!config) return;
    const field = config.schema.fields.find(f => f.key === key);
    if (!field) return;
    setDraft(d => ({ ...d, [key]: field.default }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.patch("/api/config/runtime", draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-fg-muted flex-1">Runtime Config</h2>
        <button
          className="btn text-xs"
          onClick={load}
          disabled={loading}
          aria-label="Refresh"
        >
          {loading ? "…" : "↺"}
        </button>
        <button className="btn p-1.5" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="p-4 text-red-400 text-sm">{error}</div>
        )}

        {loading && !config && (
          <div className="flex justify-center py-12">
            <div className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          </div>
        )}

        {config && (
          <AutoForm
            groups={config.schema.groups}
            fields={config.schema.fields}
            values={draft}
            onChange={handleChange}
            onReset={handleReset}
          />
        )}
      </div>

      {config && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border shrink-0">
          {saved && <span className="text-green-400 text-xs">Saved</span>}
          <div className="flex-1" />
          <button
            className="btn text-xs"
            onClick={() => { if (config) setDraft(config.values); }}
            disabled={saving}
          >
            Discard
          </button>
          <button
            className="btn-primary text-xs"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
