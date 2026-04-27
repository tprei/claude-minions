import type { ToolResultEvent } from "@minions/shared";
import { ToolResult } from "./ToolResult.js";

interface Props {
  event: ToolResultEvent;
}

export function OrphanedToolResult({ event }: Props) {
  return (
    <div className="border border-amber-700/60 rounded-lg p-1 my-1">
      <div className="text-[10px] text-amber-500 mb-1 px-1">orphaned tool result (no matching call)</div>
      <ToolResult event={event} />
    </div>
  );
}
