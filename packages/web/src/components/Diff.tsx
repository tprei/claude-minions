import { cx } from "../util/classnames.js";

interface Props {
  text: string;
  className?: string;
  wrap?: boolean;
}

interface Hunk {
  header: string;
  lines: { kind: "add" | "remove" | "context"; text: string }[];
}

function parseHunks(raw: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { header: line, lines: [] };
    } else if (current) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        current.lines.push({ kind: "add", text: line.slice(1) });
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        current.lines.push({ kind: "remove", text: line.slice(1) });
      } else if (!line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("diff ") && !line.startsWith("index ")) {
        current.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
      }
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export function Diff({ text, className, wrap = true }: Props) {
  const hunks = parseHunks(text);
  const wrapClass = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre";
  if (hunks.length === 0) {
    return (
      <pre className={cx("text-xs font-mono text-zinc-400 p-2", wrapClass, className)}>{text}</pre>
    );
  }
  return (
    <div className={cx("text-xs font-mono rounded overflow-hidden border border-border", className)}>
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="bg-zinc-800 text-blue-400 px-3 py-1 text-[11px]">{hunk.header}</div>
          {hunk.lines.map((line, j) => (
            <div
              key={j}
              className={cx(
                "px-3 py-0.5",
                wrapClass,
                line.kind === "add" && "bg-green-950 text-green-300",
                line.kind === "remove" && "bg-red-950 text-red-300",
                line.kind === "context" && "text-zinc-400",
              )}
            >
              {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
              {line.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
