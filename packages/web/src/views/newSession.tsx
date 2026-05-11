import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { WorkflowSpec } from "@minions/engine";
import { useConnectionStore } from "../connections/store.js";
import { useWorkflowStore } from "../store/workflowStore.js";
import { useVersionStore } from "../store/version.js";
import { createWorkflow, planWorkflow, ApiError } from "../transport/rest.js";
import { setUrlState } from "../routing/urlState.js";
import { AttachmentBar, useAttachments } from "../chat/attachments.js";
import { startListening, stopListening, isVoiceSupported, type VoiceSession } from "../chat/voice.js";
import { useFeature } from "../hooks/useFeature.js";
import { cx } from "../util/classnames.js";
import { PlanPreviewModal } from "./PlanPreviewModal.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string, body?: unknown) => Promise<unknown>;
}

interface Props {
  api: ApiClient;
  filterRepo?: string | null;
}

const NONE_REPO = "__none__";

function generateId(): string {
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function NewSessionView({ api: _api, filterRepo = null }: Props) {
  const activeId = useConnectionStore(s => s.activeId);
  const conn = useConnectionStore(s => s.connections.find(c => c.id === s.activeId) ?? null);
  const repos = useVersionStore(s => (activeId ? s.byConnection.get(activeId)?.repos : undefined));

  const repoIds = repos?.map(r => r.id) ?? [];
  const defaultRepoId =
    filterRepo && repoIds.includes(filterRepo)
      ? filterRepo
      : repos && repos.length > 0
        ? repos[0]!.id
        : NONE_REPO;

  type ThreadMode = "task" | "think" | "plan";
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [repoId, setRepoId] = useState<string>(defaultRepoId);
  const [baseBranch, setBaseBranch] = useState("main");
  const [threadMode, setThreadMode] = useState<ThreadMode>("task");
  const { attachments, setAttachments, onPaste, onDrop, clear } = useAttachments();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [planSpec, setPlanSpec] = useState<WorkflowSpec | null>(null);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const voiceEnabled = useFeature("voice-input");
  const voiceSupported = useMemo(() => voiceEnabled && isVoiceSupported(), [voiceEnabled]);
  const voiceRef = useRef<VoiceSession | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (voiceRef.current) {
        stopListening(voiceRef.current);
        voiceRef.current = null;
      }
    };
  }, []);

  function toggleVoice(): void {
    if (listening) {
      if (voiceRef.current) stopListening(voiceRef.current);
      voiceRef.current = null;
      setListening(false);
      return;
    }
    setVoiceError(null);
    voiceRef.current = startListening(
      (text, final) => {
        if (final) {
          setPrompt(v => (v.length > 0 && !/\s$/.test(v) ? `${v} ${text} ` : `${v}${text} `));
        }
      },
      (err) => {
        setVoiceError(err);
        if (voiceRef.current) {
          stopListening(voiceRef.current);
          voiceRef.current = null;
        }
        setListening(false);
      },
    );
    setListening(true);
  }

  const trimmedPrompt = prompt.trim();
  const promptValid = trimmedPrompt.length >= 5;
  const canSubmit = promptValid && !submitting && !!conn;

  const effectiveTitle = useMemo(() => {
    const t = title.trim();
    if (t.length > 0) return t;
    return trimmedPrompt.slice(0, 60);
  }, [title, trimmedPrompt]);

  function makeSingleTaskSpec(): WorkflowSpec {
    const taskId = generateId();
    return {
      id: generateId(),
      kind: "single-task",
      tasks: [{
        id: taskId,
        title: effectiveTitle || trimmedPrompt.slice(0, 60),
        prompt: trimmedPrompt,
        ...(repoId !== NONE_REPO && baseBranch.trim() ? { mergeTarget: baseBranch.trim() } : {}),
      }],
      policy: {},
    };
  }

  function makeThinkThreadSpec(): WorkflowSpec {
    const taskId = generateId();
    return {
      id: generateId(),
      kind: "think-thread",
      tasks: [{
        id: taskId,
        title: effectiveTitle || trimmedPrompt.slice(0, 60),
        prompt: trimmedPrompt,
      }],
      policy: { maxConcurrent: 1 },
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !activeId || !conn) return;
    setSubmitting(true);
    setError(null);
    try {
      if (threadMode === "task") {
        const spec = makeSingleTaskSpec();
        const workflow = await createWorkflow(conn, spec);
        useWorkflowStore.getState().upsert(activeId, workflow);
        clear();
        setUrlState({ connectionId: activeId, view: "list", sessionSlug: null, query: {} });
        return;
      }
      if (threadMode === "think") {
        const spec = makeThinkThreadSpec();
        const workflow = await createWorkflow(conn, spec);
        useWorkflowStore.getState().upsert(activeId, workflow);
        clear();
        setUrlState({ connectionId: activeId, view: "list", sessionSlug: null, query: {} });
        return;
      }
      let spec: WorkflowSpec;
      try {
        const result = await planWorkflow(conn, trimmedPrompt);
        spec = result.spec;
      } catch (planErr) {
        // 503 means planner unavailable/disabled — fall back to single-task
        const errStatus = (planErr !== null && typeof planErr === "object" && "status" in planErr)
          ? (planErr as { status: number }).status
          : 0;
        const is503 = errStatus === 503;
        if (is503) {
          spec = makeSingleTaskSpec();
          // Dispatch directly without showing modal when planner unavailable
          const workflow = await createWorkflow(conn, spec);
          useWorkflowStore.getState().upsert(activeId, workflow);
          clear();
          setUrlState({ connectionId: activeId, view: "list", sessionSlug: null, query: {} });
          return;
        }
        throw planErr;
      }
      setPlanSpec(spec);
      setPlanModalOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to plan workflow");
    } finally {
      setSubmitting(false);
    }
  }

  const handleConfirmPlan = useCallback(async (spec: WorkflowSpec) => {
    if (!activeId || !conn) return;
    setConfirming(true);
    try {
      const workflow = await createWorkflow(conn, spec);
      useWorkflowStore.getState().upsert(activeId, workflow);
      setPlanModalOpen(false);
      setPlanSpec(null);
      clear();
      setUrlState({ connectionId: activeId, view: "list", sessionSlug: null, query: {} });
    } finally {
      setConfirming(false);
    }
  }, [activeId, conn, clear]);

  const handleCancelPlan = useCallback(() => {
    setPlanModalOpen(false);
    setPlanSpec(null);
  }, []);

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
          <p className="text-xs text-fg-subtle mt-0.5">Spawn a task against the active connection.</p>
        </div>

        {error && (
          <div className="pill bg-err/10 border border-err/30 text-err px-3 py-1.5 text-xs">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-fg-muted">Prompt</label>
          <div className="relative">
            <textarea
              className={cx("input resize-none min-h-[140px] w-full", voiceSupported && "pr-12")}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Describe the task…"
              required
            />
            {voiceSupported && (
              <button
                type="button"
                onClick={toggleVoice}
                aria-label={listening ? "Stop voice input" : "Start voice input"}
                title={listening ? "Stop recording" : "Dictate prompt"}
                className={cx(
                  "absolute top-2 right-2 p-1.5 rounded-lg transition-colors",
                  listening
                    ? "text-red-400 bg-red-900/30 hover:bg-red-900/50"
                    : "text-fg-subtle hover:text-fg-muted hover:bg-bg-elev",
                )}
              >
                <span aria-hidden="true">🎤</span>
              </button>
            )}
          </div>
          <p className="text-xs text-fg-subtle">
            {voiceError
              ? voiceError
              : listening
                ? "Listening… tap the mic again to stop."
                : trimmedPrompt.length < 5
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

        {repos && repos.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-fg-muted">Repository</label>
            <select
              className="input"
              value={repoId}
              onChange={e => setRepoId(e.target.value)}
            >
              <option value={NONE_REPO}>(none)</option>
              {repos.map(r => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>
        )}

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
          <label className="text-xs text-fg-muted">Thread type</label>
          <div role="radiogroup" aria-label="Thread type" className="flex flex-col gap-1.5">
            <label className="flex items-start gap-2 text-xs text-fg-muted cursor-pointer select-none">
              <input
                type="radio"
                name="threadMode"
                value="task"
                checked={threadMode === "task"}
                onChange={() => setThreadMode("task")}
                className="mt-0.5"
              />
              <span>
                <span className="text-fg">Task</span>
                <span className="text-fg-subtle"> — run a single agent that edits code and commits.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-fg-muted cursor-pointer select-none">
              <input
                type="radio"
                name="threadMode"
                value="think"
                checked={threadMode === "think"}
                onChange={() => setThreadMode("think")}
                className="mt-0.5"
              />
              <span>
                <span className="text-fg">Think</span>
                <span className="text-fg-subtle"> — single read-only agent for deep research; no edits, no commits.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-fg-muted cursor-pointer select-none">
              <input
                type="radio"
                name="threadMode"
                value="plan"
                checked={threadMode === "plan"}
                onChange={() => setThreadMode("plan")}
                className="mt-0.5"
              />
              <span>
                <span className="text-fg">Plan</span>
                <span className="text-fg-subtle"> — decompose into a DAG of sub-tasks.</span>
              </span>
            </label>
          </div>
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

      <PlanPreviewModal
        open={planModalOpen}
        spec={planSpec}
        onConfirm={handleConfirmPlan}
        onCancel={handleCancelPlan}
        confirming={confirming}
      />
    </div>
  );
}
