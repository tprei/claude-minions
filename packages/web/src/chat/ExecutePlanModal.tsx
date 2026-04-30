import { useEffect, useState, type ReactElement } from "react";
import type { Session, SessionMode, CreateSessionRequest } from "@minions/shared";
import { Modal } from "../components/Modal.js";
import { Button } from "../components/Button.js";
import { Banner } from "../components/Banner.js";
import { useConnectionStore } from "../connections/store.js";
import { useRootStore } from "../store/root.js";
import { useSessionStore } from "../store/sessionStore.js";
import { useVersionStore } from "../store/version.js";
import { fetchSessionPlan, createSession } from "../transport/rest.js";
import { setUrlState } from "../routing/urlState.js";
import { cx } from "../util/classnames.js";

interface Props {
  open: boolean;
  onClose: () => void;
  parentSession: Session;
}

type PlanSource = "file" | "transcript";
type ExecuteMode = Extract<SessionMode, "task" | "ship">;

const NONE_REPO = "__none__";

export function ExecutePlanModal({ open, onClose, parentSession }: Props): ReactElement | null {
  const conn = useRootStore(s => s.getActiveConnection());
  const activeId = useConnectionStore(s => s.activeId);
  const repos = useVersionStore(s => (activeId ? s.byConnection.get(activeId)?.repos : undefined));

  const [prompt, setPrompt] = useState("");
  const [source, setSource] = useState<PlanSource | null>(null);
  const [mode, setMode] = useState<ExecuteMode>("task");
  const [repoId, setRepoId] = useState<string>(parentSession.repoId ?? NONE_REPO);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPrompt("");
      setSource(null);
      setMode("task");
      setRepoId(parentSession.repoId ?? NONE_REPO);
      setLoading(false);
      setFetchError(null);
      setSpawning(false);
      setSpawnError(null);
      return;
    }
    if (!conn) {
      setFetchError("No active connection.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetchSessionPlan(conn, parentSession.slug)
      .then(res => {
        if (cancelled) return;
        setPrompt(res.plan);
        setSource(res.source);
      })
      .catch(err => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : "Failed to load plan");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, conn, parentSession.slug, parentSession.repoId]);

  const trimmedPrompt = prompt.trim();
  const canSpawn = trimmedPrompt.length > 0 && !spawning && !!conn && !loading;

  async function handleSpawn(): Promise<void> {
    if (!canSpawn || !conn || !activeId) return;
    setSpawning(true);
    setSpawnError(null);
    try {
      const body: CreateSessionRequest = {
        prompt: trimmedPrompt,
        mode,
        parentSlug: parentSession.slug,
      };
      if (repoId !== NONE_REPO) body.repoId = repoId;
      const session = await createSession(conn, body);
      useSessionStore.getState().upsertSession(activeId, session);
      onClose();
      setUrlState({ connectionId: activeId, view: "list", sessionSlug: session.slug });
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : "Failed to spawn session");
    } finally {
      setSpawning(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Execute plan" className="max-w-2xl">
      <div className="flex flex-col gap-4">
        {loading && (
          <div className="text-xs text-fg-subtle" data-testid="plan-loading">Loading plan…</div>
        )}

        {fetchError && (
          <Banner tone="error" message={fetchError} />
        )}

        {!loading && !fetchError && source && (
          <div>
            <span
              className="pill bg-bg-elev text-fg-muted border border-border text-[11px]"
              data-testid="plan-source-pill"
            >
              {source === "file" ? "from .md file" : "from transcript"}
            </span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted" htmlFor="execute-plan-prompt">Prompt</label>
          <textarea
            id="execute-plan-prompt"
            className="input font-mono text-xs leading-snug resize-y"
            rows={12}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted" htmlFor="execute-plan-mode">Mode</label>
          <select
            id="execute-plan-mode"
            className="input"
            value={mode}
            onChange={e => setMode(e.target.value as ExecuteMode)}
          >
            <option value="task">task</option>
            <option value="ship">ship</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted" htmlFor="execute-plan-repo">Repository</label>
          <select
            id="execute-plan-repo"
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

        {spawnError && (
          <Banner tone="error" message={spawnError} />
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={spawning}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSpawn}
            disabled={!canSpawn}
            className={cx(!canSpawn && "opacity-50 cursor-not-allowed")}
          >
            {spawning ? "Spawning…" : "Spawn"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
