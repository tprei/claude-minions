import { useState, useEffect, useCallback } from "react";
import type { RuntimeConfigResponse, RuntimeOverrides } from "@minions/shared";
import { AutoForm } from "./autoForm.js";
import { Banner } from "../components/Banner.js";
import { useApiMutation } from "../hooks/useApiMutation.js";
import { useConnectionStore } from "../connections/store.js";
import { useRuntimeStore } from "../store/runtimeStore.js";

interface Props {
  api: {
    get: (path: string) => Promise<unknown>;
    patch: (path: string, body: unknown) => Promise<unknown>;
  };
  onClose: () => void;
}

export function RuntimeDrawer({ api, onClose }: Props) {
  const activeConnId = useConnectionStore(s => s.activeId);
  const [config, setConfig] = useState<RuntimeConfigResponse | null>(null);
  const [draft, setDraft] = useState<RuntimeOverrides>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [restartPending, setRestartPending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get("/api/config/runtime") as RuntimeConfigResponse;
      setConfig(res);
      setDraft(res.values);
      if (activeConnId) {
        useRuntimeStore.getState().replace(activeConnId, res.schema, res.values, res.effective);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, [api, activeConnId]);

  useEffect(() => { void load(); }, [load]);

  const saveMutation = useApiMutation<RuntimeOverrides, RuntimeConfigResponse>(
    async (overrides) => {
      const res = await api.patch("/api/config/runtime", overrides) as RuntimeConfigResponse;
      return res;
    },
    {
      onSuccess: async (_res, overrides) => {
        if (!config) return;
        const baseline = config.values;
        const restartChanged = config.schema.fields.some((f) => {
          const applies = f.applies ?? "live";
          if (applies !== "restart") return false;
          const before = baseline[f.key];
          const after = overrides[f.key];
          return JSON.stringify(before) !== JSON.stringify(after);
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        if (restartChanged) setRestartPending(true);
        await load();
      },
    },
  );

  function handleChange(key: string, value: unknown) {
    setDraft(d => ({ ...d, [key]: value }));
  }

  function handleReset(key: string) {
    if (!config) return;
    const field = config.schema.fields.find(f => f.key === key);
    if (!field) return;
    setDraft(d => ({ ...d, [key]: field.default }));
  }

  function handleSave() {
    if (!config) return;
    void saveMutation.run(draft);
  }

  const saving = saveMutation.loading;
  const mutationError = saveMutation.error;

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
        {restartPending && (
          <div className="mx-4 mt-3 px-3 py-2 rounded border border-amber-500/40 bg-amber-900/20 text-amber-200 text-xs flex items-center gap-2">
            <span className="flex-1">Restart engine to apply</span>
            <button
              type="button"
              className="text-amber-300/70 hover:text-amber-200"
              onClick={() => setRestartPending(false)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {mutationError && (
          <div className="mx-4 mt-3">
            <Banner
              tone="error"
              title={mutationError.code}
              message={mutationError.message}
              detail={mutationError.status ? `HTTP ${mutationError.status}` : undefined}
              onDismiss={() => saveMutation.reset()}
            />
          </div>
        )}

        {loadError && (
          <div className="p-4 text-red-400 text-sm">{loadError}</div>
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
