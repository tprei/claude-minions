import { useState, type FormEvent, type ReactElement } from "react";
import type { CreateVariantsRequest, CreateVariantsResponse } from "@minions/shared";
import { Banner } from "../components/Banner.js";

interface Props {
  api: {
    post: (path: string, body: unknown) => Promise<unknown>;
  };
  onClose: () => void;
}

interface FormState {
  prompt: string;
  count: string;
  repoId: string;
  baseBranch: string;
  modelHint: string;
  judgeRubric: string;
}

const INITIAL: FormState = {
  prompt: "",
  count: "3",
  repoId: "",
  baseBranch: "",
  modelHint: "",
  judgeRubric: "",
};

function parseCount(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 10) return null;
  return n;
}

export function VariantsDrawer({ api, onClose }: Props): ReactElement {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateVariantsResponse | null>(null);

  function update<K extends keyof FormState>(key: K, value: string): void {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setResult(null);

    const prompt = form.prompt.trim();
    if (!prompt) {
      setError("Prompt is required");
      return;
    }
    const count = parseCount(form.count);
    if (count === null) {
      setError("Count must be an integer between 1 and 10");
      return;
    }

    const body: CreateVariantsRequest = { prompt, count };
    if (form.repoId.trim()) body.repoId = form.repoId.trim();
    if (form.baseBranch.trim()) body.baseBranch = form.baseBranch.trim();
    if (form.modelHint.trim()) body.modelHint = form.modelHint.trim();
    if (form.judgeRubric.trim()) body.judgeRubric = form.judgeRubric.trim();

    setSubmitting(true);
    try {
      const res = await api.post("/api/sessions/variants", body) as CreateVariantsResponse;
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to spawn variants");
    } finally {
      setSubmitting(false);
    }
  }

  function reset(): void {
    setForm(INITIAL);
    setResult(null);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="variants-drawer">
      <p className="text-xs text-fg-muted">
        Spawn N parallel sessions sharing a parent. The parent counts as 1; child slugs are returned for navigation.
      </p>

      {error && (
        <Banner tone="error" title="Variants" message={error} onDismiss={() => setError(null)} />
      )}

      {result && (
        <div
          className="rounded-lg border border-border bg-bg-soft p-3 text-xs space-y-2"
          data-testid="variants-result"
        >
          <div className="text-fg-muted">Spawned</div>
          <div>
            <span className="text-fg-subtle">parent: </span>
            <code className="font-mono">{result.parentSlug}</code>
          </div>
          {result.childSlugs.length > 0 && (
            <div>
              <span className="text-fg-subtle">children:</span>
              <ul className="mt-1 space-y-0.5">
                {result.childSlugs.map(slug => (
                  <li key={slug}>
                    <code className="font-mono">{slug}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="pt-1">
            <button type="button" className="btn text-xs" onClick={reset}>
              Spawn another
            </button>
          </div>
        </div>
      )}

      {!result && (
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Prompt</span>
            <textarea
              className="input min-h-[88px] resize-y"
              value={form.prompt}
              onChange={e => update("prompt", e.target.value)}
              placeholder="Describe the task to fan out…"
              required
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Count (1–10)</span>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              value={form.count}
              onChange={e => update("count", e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Repo ID (optional)</span>
            <input
              className="input"
              value={form.repoId}
              onChange={e => update("repoId", e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Base branch (optional)</span>
            <input
              className="input"
              value={form.baseBranch}
              onChange={e => update("baseBranch", e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Model hint (optional)</span>
            <input
              className="input"
              value={form.modelHint}
              onChange={e => update("modelHint", e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Judge rubric (optional)</span>
            <textarea
              className="input min-h-[60px] resize-y"
              value={form.judgeRubric}
              onChange={e => update("judgeRubric", e.target.value)}
            />
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              className="btn-primary text-xs"
              disabled={submitting}
              data-testid="variants-submit"
            >
              {submitting ? "Spawning…" : "Spawn variants"}
            </button>
            <button type="button" className="btn text-xs" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
