import { useMemo, useState, type FormEvent } from "react";
import type { CreateSessionRequest, Session, SessionMode } from "@minions/shared";
import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";
import { setUrlState } from "../routing/urlState.js";
import { AttachmentBar, useAttachments } from "../chat/attachments.js";
import { cx } from "../util/classnames.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string) => Promise<unknown>;
}

interface Props {
  api: ApiClient;
}

const MODE_OPTIONS: { value: SessionMode; label: string }[] = [
  { value: "task", label: "Task" },
  { value: "ship", label: "Ship" },
  { value: "loop", label: "Loop" },
  { value: "think", label: "Think" },
  { value: "plan", label: "Plan" },
];

const NONE_REPO = "__none__";

export function NewSessionView({ api }: Props) {
  const activeId = useConnectionStore(s => s.activeId);
  const repos = useVersionStore(s => (activeId ? s.byConnection.get(activeId)?.repos : undefined));

  const defaultRepoId = repos && repos.length > 0 ? repos[0]!.id : NONE_REPO;

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<SessionMode>("task");
  const [repoId, setRepoId] = useState<string>(defaultRepoId);
  const [baseBranch, setBaseBranch] = useState("main");
  const [modelHint, setModelHint] = useState("");
  const { attachments, setAttachments, onPaste, onDrop, clear } = useAttachments();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedPrompt = prompt.trim();
  const promptValid = trimmedPrompt.length >= 5;
  const canSubmit = promptValid && !submitting;

  const effectiveTitle = useMemo(() => {
    const t = title.trim();
    if (t.length > 0) return t;
    return trimmedPrompt.slice(0, 60);
  }, [title, trimmedPrompt]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !activeId) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: CreateSessionRequest = {
        prompt: trimmedPrompt,
        title: effectiveTitle,
        mode,
      };
      if (repoId !== NONE_REPO) {
        body.repoId = repoId;
        const branch = baseBranch.trim();
        if (branch.length > 0) body.baseBranch = branch;
      }
      const hint = modelHint.trim();
      if (hint.length > 0) body.modelHint = hint;
      if (attachments.length > 0) {
        body.attachments = attachments.map(a => ({
          name: a.name,
          mimeType: a.mimeType,
          dataBase64: a.dataBase64,
        }));
      }
      const session = (await api.post("/api/sessions", body)) as Session;
      clear();
      setUrlState({ connectionId: activeId, view: "list", sessionSlug: session.slug });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setSubmitting(false);
    }
  }

  if (!activeId) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-fg-subtle">
        No active connection.
      </div>
    );
  }

  return (
    <div
      className="h-full overflow-y-auto"
      onPaste={onPaste}
      onDrop={(e) => { e.preventDefault(); onDrop(e); }}
      onDragOver={(e) => e.preventDefault()}
    >
      <form onSubmit={handleSubmit} className="max-w-2xl mx-auto p-6 flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold text-fg">New session</h1>
          <p className="text-xs text-fg-subtle mt-0.5">Spawn a session against the active connection.</p>
        </div>

        {error && (
          <div className="pill bg-err/10 border border-err/30 text-err px-3 py-1.5 text-xs">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted">Prompt</label>
          <textarea
            className="input resize-none min-h-[140px]"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Describe the task…"
            required
          />
          <p className="text-xs text-fg-subtle">
            {trimmedPrompt.length < 5
              ? `Need at least 5 characters (${trimmedPrompt.length}/5).`
              : `${trimmedPrompt.length} characters.`}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted">Title (optional)</label>
          <input
            className="input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={trimmedPrompt.slice(0, 60) || "Defaults to first 60 chars of prompt"}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted">Mode</label>
          <div className="flex gap-2 flex-wrap">
            {MODE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                className={cx(
                  "pill cursor-pointer border",
                  mode === opt.value
                    ? "bg-accent/20 border-accent text-accent"
                    : "border-border text-fg-muted hover:text-fg",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted">Repository</label>
          <select
            className="input"
            value={repoId}
            onChange={e => setRepoId(e.target.value)}
          >
            <option value={NONE_REPO}>(none)</option>
            {(repos ?? []).map(r => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>

        {repoId !== NONE_REPO && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-fg-muted">Base branch</label>
            <input
              className="input"
              value={baseBranch}
              onChange={e => setBaseBranch(e.target.value)}
              placeholder="main"
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted">Model hint (optional)</label>
          <input
            className="input"
            value={modelHint}
            onChange={e => setModelHint(e.target.value)}
            placeholder="claude-3-5-sonnet-20241022"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted">Attachments</label>
          <p className="text-xs text-fg-subtle">Paste or drop images anywhere on this page.</p>
          <AttachmentBar attachments={attachments} onChange={setAttachments} />
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className={cx(
              "btn-primary",
              !canSubmit && "opacity-50 cursor-not-allowed",
            )}
          >
            {submitting ? "Creating…" : "Create session"}
          </button>
        </div>
      </form>
    </div>
  );
}
