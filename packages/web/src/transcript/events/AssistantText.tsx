import type { AssistantTextEvent } from "@minions/shared";
import { MarkdownView } from "../../markdown/MarkdownView.js";
import { cx } from "../../util/classnames.js";

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

interface Props {
  event: AssistantTextEvent;
}

export function AssistantText({ event }: Props) {
  return (
    <div className={cx("flex items-start gap-2 py-1", event.partial && "opacity-70")}>
      <div
        className="shrink-0 w-7 h-7 rounded-full bg-accent-muted text-accent-soft text-xs font-semibold flex items-center justify-center"
        aria-label="assistant"
      >
        A
      </div>
      <div className="max-w-[85%] bg-bg-soft border border-border rounded-xl px-3 py-2 min-w-0 text-sm text-fg">
        <div className="flex items-center justify-between gap-3 mb-1">
          <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
            assistant
          </span>
          <span className="text-[10px] font-mono text-fg-subtle">
            {formatTs(event.timestamp)}
          </span>
        </div>
        <MarkdownView text={event.text} />
      </div>
    </div>
  );
}
