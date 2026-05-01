import type { ReactElement } from "react";
import type { DiffStat } from "../../types.js";
import { cx } from "../../util/classnames.js";

interface Props {
  files: DiffStat[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface BadgeMeta {
  label: string;
  className: string;
}

const STATUS_BADGE: Record<DiffStat["status"], BadgeMeta> = {
  added: { label: "A", className: "text-green-400" },
  modified: { label: "M", className: "text-yellow-400" },
  deleted: { label: "D", className: "text-red-400" },
  renamed: { label: "R", className: "text-blue-400" },
  untracked: { label: "U", className: "text-fg-subtle" },
};

const ARROW = "→";

export function FileList({ files, selectedPath, onSelect }: Props): ReactElement {
  let totalAdds = 0;
  let totalDels = 0;
  for (const f of files) {
    totalAdds += f.additions;
    totalDels += f.deletions;
  }

  return (
    <div className="flex flex-col text-xs font-mono bg-bg-soft border border-border h-full overflow-hidden">
      <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-2 bg-bg-elev border-b border-border text-fg-muted">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span>
          <span className="text-green-400">+{totalAdds}</span>
          <span className="mx-1 text-fg-subtle">/</span>
          <span className="text-red-400">-{totalDels}</span>
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {files.map((file) => {
          const badge = STATUS_BADGE[file.status];
          const active = file.path === selectedPath;
          const display =
            file.status === "renamed" && file.oldPath
              ? `${file.oldPath} ${ARROW} ${file.path}`
              : file.path;
          return (
            <button
              key={file.path}
              type="button"
              data-testid="diffview-file-row"
              data-path={file.path}
              onClick={() => onSelect(file.path)}
              className={cx(
                "flex items-center gap-2 w-full text-left px-3 py-1.5 border-b border-border hover:bg-bg-elev",
                active && "bg-bg-elev",
              )}
            >
              <span className={cx("w-4 shrink-0 font-semibold", badge.className)}>
                {badge.label}
              </span>
              <span className="flex-1 truncate text-fg" title={display}>
                {display}
              </span>
              <span className="shrink-0 text-green-400">+{file.additions}</span>
              <span className="shrink-0 text-red-400">-{file.deletions}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
