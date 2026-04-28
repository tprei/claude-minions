import type { ComponentType } from "react";
import type { TranscriptEvent } from "@minions/shared";
import { AssistantText } from "./AssistantText.js";
import { Thinking } from "./Thinking.js";
import { UserMessage } from "./UserMessage.js";
import { ToolCall } from "./ToolCall.js";
import { ToolResult } from "./ToolResult.js";
import { TurnStarted } from "./TurnStarted.js";
import { TurnCompleted } from "./TurnCompleted.js";
import { StatusBanner } from "./StatusBanner.js";

type EventComponent = ComponentType<{ event: TranscriptEvent }>;

function wrap<E extends TranscriptEvent>(
  Comp: ComponentType<{ event: E }>,
): EventComponent {
  return Comp as unknown as EventComponent;
}

const EVENT_MAP: Partial<Record<TranscriptEvent["kind"], EventComponent>> = {
  assistant_text: wrap(AssistantText),
  thinking: wrap(Thinking),
  user_message: wrap(UserMessage),
  status: wrap(StatusBanner),
  tool_call: wrap(ToolCall),
  tool_result: wrap(ToolResult),
  turn_started: wrap(TurnStarted),
  turn_completed: wrap(TurnCompleted),
};

export function pickComponent(event: TranscriptEvent): EventComponent | null {
  return EVENT_MAP[event.kind] ?? null;
}

export {
  AssistantText,
  Thinking,
  UserMessage,
  ToolCall,
  ToolResult,
  TurnStarted,
  TurnCompleted,
  StatusBanner,
};
