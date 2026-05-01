import type { ReactElement, ReactNode } from "react";
import DOMPurify from "dompurify";
import { Button } from "../Button.js";
import { highlight } from "../../markdown/highlight.js";
import { cx } from "../../util/classnames.js";
import { languageFromPath } from "./languageFromPath.js";
import type { DiffLine, ParsedFile } from "./parsePatch.js";

interface Props {
  file: ParsedFile;
  viewMode: "unified" | "split";
  hunkIndex: number;
  onPrevHunk: () => void;
  onNextHunk: () => void;
  toggleSlot?: ReactNode;
}

export function DiffPane({
  file,
  hunkIndex,
  onPrevHunk,
  onNextHunk,
  toggleSlot,
}: Props): ReactElement {
  const displayPath =
    file.oldPath && file.oldPath !== file.path
      ? `${file.oldPath} → ${file.path}`
      : file.path;
  const lang = languageFromPath(file.path);
  const total = file.hunks.length;
  const atStart = hunkIndex <= 0;
  const atEnd = total === 0 || hunkIndex >= total - 1;

  return (
    <div className="text-xs font-mono rounded overflow-hidden border border-border">
      <div className="flex items-center justify-between bg-bg-elev border-b border-border px-3 py-1">
        <div className="font-semibold text-[11px] text-fg truncate">
          {displayPath}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onPrevHunk}
            disabled={atStart}
          >
            Prev
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onNextHunk}
            disabled={atEnd}
          >
            Next
          </Button>
          <span className="text-fg-muted text-[11px] select-none">
            {total > 0 ? `${hunkIndex + 1}/${total}` : "0/0"}
          </span>
          {toggleSlot}
        </div>
      </div>
      {file.isBinary ? (
        <div className="p-3 text-fg-muted">Binary file — no preview</div>
      ) : (
        <div data-active-hunk={hunkIndex}>
          {file.hunks.map((hunk, i) => (
            <div key={i} data-hunk-index={i}>
              <div className="bg-bg-elev text-blue-400 px-3 py-1 text-[11px]">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => (
                <DiffLineRow key={li} line={line} lang={lang} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffLineRow({
  line,
  lang,
}: {
  line: DiffLine;
  lang: string | undefined;
}): ReactElement {
  const html = DOMPurify.sanitize(highlight(line.text, lang), {
    USE_PROFILES: { html: true },
  });
  const bg =
    line.kind === "add"
      ? "bg-green-950 text-green-300"
      : line.kind === "del"
        ? "bg-red-950 text-red-300"
        : "";
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return (
    <div className={cx("flex items-start", bg)}>
      <span className="select-none text-right text-fg-subtle px-2 w-10 shrink-0 tabular-nums">
        {line.oldNo ?? ""}
      </span>
      <span className="select-none text-right text-fg-subtle px-2 w-10 shrink-0 tabular-nums">
        {line.newNo ?? ""}
      </span>
      <span className="select-none px-1 shrink-0">{sign}</span>
      <code
        className={`hljs language-${lang ?? "plaintext"} whitespace-pre-wrap break-words flex-1`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
