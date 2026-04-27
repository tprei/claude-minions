import type { UserMessageEvent } from "@minions/shared";
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

interface Props {
  event: UserMessageEvent;
}

export function UserMessage({ event }: Props) {
  const source = event.source ?? "operator";
  return (
    <div className="flex flex-col items-end gap-1 py-1">
      <div className="flex items-center gap-2">
        <span className={cx("pill text-[10px]", SOURCE_COLORS[source])}>
          {SOURCE_LABELS[source]}
        </span>
        {event.injected && (
          <span className="pill text-[10px] bg-bg-elev text-fg-muted">injected</span>
        )}
      </div>
      <div className="max-w-[80%] bg-blue-900/40 border border-blue-700/40 rounded-xl px-3 py-2 text-sm text-fg whitespace-pre-wrap">
        {event.text}
      </div>
      {event.attachments && event.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {event.attachments.map((a, i) => (
            <span key={i} className="pill bg-bg-elev text-fg-muted text-[10px]">
              {a.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
