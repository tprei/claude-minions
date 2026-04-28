import type { AssistantTextEvent } from "@minions/shared";
import { MarkdownText } from "../markdown.js";
import { cx } from "../../util/classnames.js";

interface Props {
  event: AssistantTextEvent;
}

export function AssistantText({ event }: Props) {
  return (
    <div className={cx("py-1 text-sm text-fg", event.partial && "opacity-70")}>
      <MarkdownText text={event.text} />
    </div>
  );
}
