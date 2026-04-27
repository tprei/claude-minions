import type { AssistantTextEvent } from "@minions/shared";
import { Markdown } from "../../components/Markdown.js";
import { cx } from "../../util/classnames.js";

interface Props {
  event: AssistantTextEvent;
}

export function AssistantText({ event }: Props) {
  return (
    <div className={cx("py-1", event.partial && "opacity-70")}>
      <Markdown text={event.text} />
    </div>
  );
}
