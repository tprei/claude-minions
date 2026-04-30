import type { ToolCallEvent, ToolResultEvent } from "@minions/shared";
import { ToolCallRow } from "./ToolCallRow.js";

interface Props {
  event: ToolCallEvent;
  result?: ToolResultEvent;
}

export function ToolCall({ event, result }: Props) {
  return <ToolCallRow call={event} result={result} />;
}
