import { cx } from "../util/classnames.js";
import { highlight } from "../markdown/highlight.js";
import { sanitizeMarkdownHtml } from "../markdown/sanitize.js";
import "../markdown/highlight.css";
import { languageFromPath } from "./DiffView/languageFromPath.js";
import { parsePatch, type DiffLine, type ParsedFile } from "./DiffView/parsePatch.js";

interface Props {
  text: string;
  className?: string;
  wrap?: boolean;
}

function renderHighlighted(text: string, language?: string): string {
  if (!text) return "";
  const html = highlight(text, language);
  return sanitizeMarkdownHtml(html);
}

interface LineProps {
  line: DiffLine;
  language?: string;
  wrapClass: string;
}

function Line({ line, language, wrapClass }: LineProps) {
  const html = renderHighlighted(line.text, language);
  return (
    <div
      className={cx(
        "diff-line px-3 py-0.5",
        wrapClass,
        line.kind === "add" && "bg-green-950/60",
        line.kind === "del" && "bg-red-950/60",
        line.kind === "context" && "text-fg-muted",
      )}
    >
      <span className="select-none mr-1 text-fg-subtle">
        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
      </span>
      <code className="hljs diff-line-code" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function fileLabel(file: ParsedFile): string {
  if (file.oldPath && file.oldPath !== file.path) return `${file.oldPath} → ${file.path}`;
  return file.path;
}

function zeroHunkLabel(file: ParsedFile): string {
  if (file.isBinary) return "Binary file - no preview";
  if (file.status === "renamed") return "Renamed file";
  return "No textual changes";
}

export function Diff({ text, className, wrap = true }: Props) {
  const files = parsePatch(text);
  const wrapClass = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre";

  if (files.length === 0) {
    return (
      <pre className={cx("text-xs font-mono text-fg-muted p-2", wrapClass, className)}>
        {text}
      </pre>
    );
  }

  return (
    <div className={cx("text-xs font-mono rounded overflow-hidden border border-border", className)}>
      {files.map((file, fi) => (
        <div key={fi}>
          {(file.path || files.length > 1) && (
            <div className="bg-bg-elev text-fg-muted px-3 py-1 text-[11px] font-semibold border-t border-border first:border-t-0">
              {fileLabel(file)}
            </div>
          )}
          {file.hunks.length === 0 && (
            <div className="diff-line px-3 py-1 text-fg-muted">
              {zeroHunkLabel(file)}
            </div>
          )}
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="bg-bg-elev text-blue-400 px-3 py-1 text-[11px]">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => (
                <Line
                  key={li}
                  line={line}
                  language={languageFromPath(file.path)}
                  wrapClass={wrapClass}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
