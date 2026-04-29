import { useState, useEffect, useCallback, type FormEvent, type ReactElement } from "react";
import type { Entrypoint, EntrypointKind, RegisterEntrypointRequest, ListEnvelope } from "@minions/shared";
import { Banner } from "../components/Banner.js";

interface Props {
  api: {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body: unknown) => Promise<unknown>;
  };
  onClose: () => void;
}

const KINDS: EntrypointKind[] = [
  "github-webhook",
  "linear-webhook",
  "slack-event",
  "email",
  "custom",
];

interface FormState {
  kind: EntrypointKind;
  label: string;
  configJson: string;
}

const INITIAL_FORM: FormState = {
  kind: "custom",
  label: "",
  configJson: "",
};

function parseConfig(raw: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Config must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Config must be valid JSON" };
  }
}

export function EntrypointsDrawer({ api, onClose }: Props): ReactElement {
  const [items, setItems] = useState<Entrypoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get("/api/entrypoints") as ListEnvelope<Entrypoint>;
      setItems(res.items ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load entrypoints");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    const label = form.label.trim();
    if (!label) {
      setSubmitError("Label is required");
      return;
    }
    const cfg = parseConfig(form.configJson);
    if (!cfg.ok) {
      setSubmitError(cfg.error);
      return;
    }
    const body: RegisterEntrypointRequest = { kind: form.kind, label };
    if (cfg.value) body.config = cfg.value;

    setSubmitting(true);
    try {
      await api.post("/api/entrypoints", body);
      setForm(INITIAL_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to register entrypoint");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="entrypoints-drawer">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-fg-muted">
          Webhooks and external triggers that can spawn sessions.
        </p>
        <button
          type="button"
          className="btn text-xs"
          onClick={load}
          disabled={loading}
          aria-label="Refresh"
        >
          {loading ? "…" : "↺"}
        </button>
        {!showForm && (
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={() => setShowForm(true)}
            data-testid="entrypoints-new"
          >
            New
          </button>
        )}
      </div>

      {loadError && (
        <Banner tone="error" title="Entrypoints" message={loadError} onDismiss={() => setLoadError(null)} />
      )}

      {!loading && items.length === 0 && !showForm && (
        <div className="text-xs text-fg-subtle py-4 text-center">No entrypoints registered yet.</div>
      )}

      {items.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="entrypoints-list">
          {items.map(ep => (
            <li
              key={ep.id}
              className="rounded-lg border border-border bg-bg-soft p-3 text-xs flex flex-col gap-1"
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold text-fg">{ep.label}</span>
                <span className="text-fg-subtle">{ep.kind}</span>
                <span className="flex-1" />
                <span className={ep.enabled ? "text-green-400" : "text-fg-subtle"}>
                  {ep.enabled ? "enabled" : "disabled"}
                </span>
              </div>
              {ep.url && (
                <code className="font-mono text-[11px] text-fg-muted break-all">{ep.url}</code>
              )}
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <form className="flex flex-col gap-3 border-t border-border pt-3" onSubmit={handleSubmit}>
          {submitError && (
            <Banner tone="error" title="Register" message={submitError} onDismiss={() => setSubmitError(null)} />
          )}

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Kind</span>
            <select
              className="input"
              value={form.kind}
              onChange={e => update("kind", e.target.value as EntrypointKind)}
            >
              {KINDS.map(k => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Label</span>
            <input
              className="input"
              value={form.label}
              onChange={e => update("label", e.target.value)}
              placeholder="github bug triage"
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Config (JSON, optional)</span>
            <textarea
              className="input min-h-[80px] resize-y font-mono"
              value={form.configJson}
              onChange={e => update("configJson", e.target.value)}
              placeholder='{"repo": "owner/name"}'
            />
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              className="btn-primary text-xs"
              disabled={submitting}
              data-testid="entrypoints-submit"
            >
              {submitting ? "Registering…" : "Register"}
            </button>
            <button
              type="button"
              className="btn text-xs"
              onClick={() => { setShowForm(false); setSubmitError(null); }}
            >
              Cancel
            </button>
            <span className="flex-1" />
            <button type="button" className="btn text-xs" onClick={onClose}>
              Close
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
