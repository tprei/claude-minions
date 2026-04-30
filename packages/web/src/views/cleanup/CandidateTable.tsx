import type { ReactElement } from "react";
import type { CleanupCandidate, SessionStatus } from "@minions/shared";
import { fmtBytes, relTime } from "../../util/time.js";
import { cx } from "../../util/classnames.js";

interface Props {
  candidates: CleanupCandidate[];
  selected: Set<string>;
  onToggle: (slug: string) => void;
  onToggleAll: (next: boolean) => void;
}

const STATUS_PILL: Record<SessionStatus, string> = {
  pending: "bg-zinc-800 text-zinc-300",
  running: "bg-green-900/40 text-green-300",
  waiting_input: "bg-amber-900/40 text-amber-300",
  completed: "bg-blue-900/40 text-blue-300",
  failed: "bg-red-900/40 text-red-300",
  cancelled: "bg-zinc-800 text-zinc-400",
};

export function CandidateTable({ candidates, selected, onToggle, onToggleAll }: Props): ReactElement {
  if (candidates.length === 0) {
    return (
      <div className="text-xs text-fg-subtle text-center py-6 border border-dashed border-border rounded-lg">
        No cleanup candidates match the current filters.
      </div>
    );
  }

  const allSelected = candidates.every((c) => selected.has(c.slug));
  const someSelected = !allSelected && candidates.some((c) => selected.has(c.slug));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-bg-soft border-b border-border text-xs text-fg-subtle">
          <tr>
            <th className="px-3 py-2 w-8">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={(e) => onToggleAll(e.target.checked)}
                aria-label="Select all"
              />
            </th>
            <th className="text-left px-3 py-2 font-normal">slug</th>
            <th className="text-left px-3 py-2 font-normal">title</th>
            <th className="text-left px-3 py-2 font-normal">status</th>
            <th className="text-left px-3 py-2 font-normal">completed</th>
            <th className="text-left px-3 py-2 font-normal">branch</th>
            <th className="text-right px-3 py-2 font-normal">bytes</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => {
            const isSelected = selected.has(c.slug);
            return (
              <tr
                key={c.slug}
                onClick={() => onToggle(c.slug)}
                className={cx(
                  "border-b border-border-soft cursor-pointer hover:bg-bg-elev/40 transition-colors",
                  isSelected && "bg-accent/10",
                )}
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(c.slug)}
                    aria-label={`Select ${c.slug}`}
                  />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-fg-muted">{c.slug}</td>
                <td className="px-3 py-2 text-fg truncate max-w-xs">{c.title}</td>
                <td className="px-3 py-2">
                  <span className={cx("pill text-[10px]", STATUS_PILL[c.status] ?? "bg-bg-elev text-fg-muted")}>
                    {c.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted">
                  {c.completedAt ? relTime(c.completedAt) : "—"}
                </td>
                <td className="px-3 py-2 text-xs font-mono text-fg-muted truncate max-w-[10rem]">
                  {c.branch ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs font-mono text-fg text-right">
                  {fmtBytes(c.worktreeBytes)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
