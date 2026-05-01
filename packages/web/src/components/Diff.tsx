import DOMPurify from "dompurify";
import { cx } from "../util/classnames.js";
import { highlight, languageForFilename } from "../markdown/highlight.js";
import "../markdown/highlight.css";

interface Props {
  text: string;
  className?: string;
  wrap?: boolean;
}

interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

interface Hunk {
  header: string;
  lines: DiffLine[];
}

interface FileBlock {
  filename?: string;
  language?: string;
  hunks: Hunk[];
}

function stripPathPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function parseDiff(raw: string): FileBlock[] {
  const files: FileBlock[] = [];
  let file: FileBlock | null = null;
  let hunk: Hunk | null = null;

  const flushHunk = () => {
    if (hunk && file) file.hunks.push(hunk);
    hunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (file) files.push(file);
    file = null;
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      file = { hunks: [] };
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        const target = m[2] ?? m[1];
        if (target) {
          file.filename = stripPathPrefix(target);
          file.language = languageForFilename(file.filename);
        }
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!file) file = { hunks: [] };
      const path = line.slice(4).trim();
      if (path && path !== "/dev/null") {
        file.filename = stripPathPrefix(path);
        file.language = languageForFilename(file.filename);
      }
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("index ")) continue;
    if (line.startsWith("new file mode") || line.startsWith("deleted file mode")) continue;
    if (line.startsWith("similarity index") || line.startsWith("rename ")) continue;

    if (line.startsWith("@@")) {
      if (!file) file = { hunks: [] };
      flushHunk();
      hunk = { header: line, lines: [] };
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "remove", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: line.slice(1) });
    } else if (line.startsWith("\\ ")) {
      // "\ No newline at end of file" — preserve as context
      hunk.lines.push({ kind: "context", text: line });
    }
  }
  flushFile();

  return files.filter((f) => f.hunks.length > 0);
}

function renderHighlighted(text: string, language?: string): string {
  if (!text) return "";
  const html = highlight(text, language);
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
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
        line.kind === "remove" && "bg-red-950/60",
        line.kind === "context" && "text-fg-muted",
      )}
    >
      <span className="select-none mr-1 text-fg-subtle">
        {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
      </span>
      <code className="hljs diff-line-code" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function Diff({ text, className, wrap = true }: Props) {
  const files = parseDiff(text);
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
          {file.filename && files.length > 1 && (
            <div className="bg-bg-elev text-fg-muted px-3 py-1 text-[11px] font-semibold border-t border-border first:border-t-0">
              {file.filename}
            </div>
          )}
          {file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="bg-bg-elev text-blue-400 px-3 py-1 text-[11px]">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => (
                <Line key={li} line={line} language={file.language} wrapClass={wrapClass} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
