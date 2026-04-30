import type { PermissionTier } from "@minions/shared";

export interface ProviderSpawnOpts {
  sessionSlug: string;
  worktree: string;
  prompt: string;
  modelHint?: string;
  env: Record<string, string>;
  preamble?: string;
  attachments?: { name: string; mimeType: string; dataBase64: string }[];
  mcpConfigPath?: string;
  additionalPrompt?: string;
  permissionTier?: PermissionTier;
  worktreeGitDir?: string;
  worktreeGitCommonDir?: string;
}

export interface ProviderResumeOpts {
  sessionSlug: string;
  worktree: string;
  externalId?: string;
  env: Record<string, string>;
  mcpConfigPath?: string;
  additionalPrompt?: string;
  permissionTier?: PermissionTier;
  worktreeGitDir?: string;
  worktreeGitCommonDir?: string;
}

export interface ProviderHandle {
  pid: number | undefined;
  externalId?: string;
  kill(signal: NodeJS.Signals): void;
  write(text: string): void;
  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent>;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export type ProviderEventKind =
  | "assistant_text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "turn_started"
  | "turn_completed"
  | "status"
  | "session_id";

export interface ProviderAssistantTextEvent {
  kind: "assistant_text";
  text: string;
  partial?: boolean;
}

export interface ProviderThinkingEvent {
  kind: "thinking";
  text: string;
}

export interface ProviderToolCallEvent {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ProviderToolResultEvent {
  kind: "tool_result";
  toolCallId: string;
  toolName?: string;
  status: "ok" | "error" | "partial";
  body: string;
  truncated?: boolean;
}

export interface ProviderTurnStartedEvent {
  kind: "turn_started";
}

export interface ProviderTurnCompletedEvent {
  kind: "turn_completed";
  outcome: "success" | "stopped" | "errored" | "needs_input";
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  costUsd?: number;
}

export interface ProviderStatusEvent {
  kind: "status";
  level: "info" | "warn" | "error";
  text: string;
  data?: Record<string, unknown>;
}

export interface ProviderSessionIdEvent {
  kind: "session_id";
  externalId: string;
}

export type ProviderEvent =
  | ProviderAssistantTextEvent
  | ProviderThinkingEvent
  | ProviderToolCallEvent
  | ProviderToolResultEvent
  | ProviderTurnStartedEvent
  | ProviderTurnCompletedEvent
  | ProviderStatusEvent
  | ProviderSessionIdEvent;

export interface ParseStreamState {
  buffer: string;
  turn: number;
  [key: string]: unknown;
}

export interface AgentProvider {
  name: string;
  spawn(opts: ProviderSpawnOpts): Promise<ProviderHandle>;
  resume(opts: ProviderResumeOpts): Promise<ProviderHandle>;
  parseStreamChunk(buf: string, state: ParseStreamState): { events: ProviderEvent[]; state: ParseStreamState };
  detectQuotaError(text: string): boolean;
}
