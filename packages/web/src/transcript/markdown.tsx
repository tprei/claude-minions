import type { ReactElement, ReactNode } from "react";
import { cx } from "../util/classnames.js";

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_CODE_RE.lastIndex = 0;
  while ((m = INLINE_CODE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <code
        key={`c-${key++}`}
        className="font-mono bg-bg-elev px-1 py-0.5 rounded text-[11px]"
      >
        {m[1] ?? ""}
      </code>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderProse(text: string, baseKey: string): ReactNode[] {
  return text
    .split(/\n\n+/)
    .filter((p) => p.length > 0)
    .map((p, i) => (
      <p key={`${baseKey}-p${i}`} className="whitespace-pre-wrap break-words">
        {renderInline(p)}
      </p>
    ));
}

export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}): ReactElement {
  const blocks: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > last) {
      blocks.push(...renderProse(text.slice(last, m.index), `b${key}`));
    }
    blocks.push(
      <pre
        key={`f-${key++}`}
        className="border border-border bg-bg-elev text-fg rounded-md p-2 overflow-x-auto text-[11px] font-mono whitespace-pre"
      >
        {m[2] ?? ""}
      </pre>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    blocks.push(...renderProse(text.slice(last), `b${key}`));
  }
  return <div className={cx("space-y-1.5", className)}>{blocks}</div>;
}
