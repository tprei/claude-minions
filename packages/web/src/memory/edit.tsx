import { useState } from "react";
import type { Memory, MemoryKind, CreateMemoryRequest } from "@minions/shared";
import { cx } from "../util/classnames.js";

interface Props {
  memory?: Memory;
  onSave: (req: CreateMemoryRequest | Partial<CreateMemoryRequest>) => Promise<void>;
  onCancel: () => void;
}

const KINDS: MemoryKind[] = ["user", "feedback", "project", "reference"];

export function MemoryEdit({ memory, onSave, onCancel }: Props) {
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? "project");
  const [scope, setScope] = useState<"global" | "repo">(memory?.scope ?? "global");
  const [repoId, setRepoId] = useState(memory?.repoId ?? "");
  const [pinned, setPinned] = useState(memory?.pinned ?? false);
  const [title, setTitle] = useState(memory?.title ?? "");
  const [body, setBody] = useState(memory?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        kind,
        scope,
        repoId: scope === "repo" ? repoId.trim() || undefined : undefined,
        pinned,
        title: title.trim(),
        body: body.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-zinc-400">Kind</label>
        <div className="flex gap-2 flex-wrap">
          {KINDS.map(k => (
            <button
              key={k}
              type="button"
              className={cx("pill cursor-pointer border", kind === k
                ? "bg-accent/20 border-accent text-accent"
                : "border-border text-zinc-400")}
              onClick={() => setKind(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-zinc-400">Scope</label>
        <div className="flex gap-2">
          {(["global", "repo"] as const).map(s => (
            <button
              key={s}
              type="button"
              className={cx("pill cursor-pointer border", scope === s
                ? "bg-accent/20 border-accent text-accent"
                : "border-border text-zinc-400")}
              onClick={() => setScope(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {scope === "repo" && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-zinc-400">Repo ID</label>
          <input
            className="input"
            value={repoId}
            onChange={e => setRepoId(e.target.value)}
            placeholder="repo-id"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          id="pinned"
          type="checkbox"
          checked={pinned}
          onChange={e => setPinned(e.target.checked)}
          className="accent-accent"
        />
        <label htmlFor="pinned" className="text-sm text-zinc-300">Pinned</label>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-zinc-400">Title</label>
        <input
          className="input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Memory title"
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-zinc-400">Body</label>
        <textarea
          className="input resize-none min-h-[120px]"
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Memory content..."
          required
        />
      </div>

      {error && (
        <p className="text-red-400 text-sm">{error}</p>
      )}

      <div className="flex gap-2 justify-end pt-1">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary"
          disabled={saving || !title.trim() || !body.trim()}
        >
          {saving ? "Saving…" : memory ? "Update" : "Create"}
        </button>
      </div>
    </form>
  );
}
