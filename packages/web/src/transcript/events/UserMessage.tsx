import type { UserMessageEvent } from "@minions/shared";
import { MarkdownView } from "../../markdown/MarkdownView.js";
import { cx } from "../../util/classnames.js";

const SOURCE_LABELS: Record<NonNullable<UserMessageEvent["source"]>, string> = {
  operator: "operator",
  external: "external",
  loop: "loop",
  completion: "completion",
};

const SOURCE_COLORS: Record<NonNullable<UserMessageEvent["source"]>, string> = {
  operator: "bg-blue-900 text-blue-300",
  external: "bg-amber-900 text-amber-300",
  loop: "bg-purple-900 text-purple-300",
  completion: "bg-bg-elev text-fg-muted",
};

const SOURCE_INITIAL: Record<NonNullable<UserMessageEvent["source"]>, string> = {
  operator: "O",
  external: "E",
  loop: "L",
  completion: "C",
};

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

interface Props {
  event: UserMessageEvent;
}

export function UserMessage({ event }: Props) {
  const source = event.source ?? "operator";
  return (
    <div className="flex items-start justify-end gap-2 py-1">
      <div className="flex flex-col items-end gap-1 max-w-[85%] min-w-0">
        <div className="bg-blue-900/40 border border-blue-700/40 rounded-xl px-3 py-2 text-sm text-fg w-full">
          <div className="flex items-center justify-between gap-3 mb-1">
            <div className="flex items-center gap-1">
              <span className={cx("pill text-[10px]", SOURCE_COLORS[source])}>
                {SOURCE_LABELS[source]}
              </span>
              {event.injected && (
                <span className="pill text-[10px] bg-bg-elev text-fg-muted">injected</span>
              )}
            </div>
            <span className="text-[10px] font-mono text-fg-subtle">
              {formatTs(event.timestamp)}
            </span>
          </div>
          <MarkdownView text={event.text} />
        </div>
        {event.attachments && event.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 justify-end">
            {event.attachments.map((a, i) => (
              <span key={i} className="pill bg-bg-elev text-fg-muted text-[10px]">
                {a.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        className={cx(
          "shrink-0 w-7 h-7 rounded-full text-xs font-semibold flex items-center justify-center",
          SOURCE_COLORS[source],
        )}
        aria-label={`source ${source}`}
      >
        {SOURCE_INITIAL[source]}
      </div>
    </div>
  );
}
