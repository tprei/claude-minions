import type {
  Session,
  SessionStatus,
  SessionMode,
  ShipStage,
  AttentionFlag,
  QuickAction,
  SessionStats,
  PRSummary,
  TranscriptEvent,
  TranscriptEventKind,
  UserMessageEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  AssistantTextEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  StatusEvent,
  ToolKind,
  ToolResultStatus,
  ToolResultFormat,
} from "@minions/shared";
import type { ProviderEvent } from "../providers/provider.js";

export interface SessionRow {
  slug: string;
  title: string;
  prompt: string;
  mode: string;
  status: string;
  ship_stage: string | null;
  repo_id: string | null;
  branch: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  parent_slug: string | null;
  root_slug: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_draft: number;
  pr_base: string | null;
  pr_head: string | null;
  pr_title: string | null;
  attention: string;
  quick_actions: string;
  stats_turns: number;
  stats_input_tokens: number;
  stats_output_tokens: number;
  stats_cache_read_tokens: number;
  stats_cache_creation_tokens: number;
  stats_cost_usd: number;
  stats_duration_ms: number;
  stats_tool_calls: number;
  provider: string;
  model_hint: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_turn_at: string | null;
  dag_id: string | null;
  dag_node_id: string | null;
  loop_id: string | null;
  variant_of: string | null;
  metadata: string;
}

export interface TranscriptRow {
  id: string;
  session_slug: string;
  seq: number;
  turn: number;
  kind: string;
  body: string;
  timestamp: string;
}

export function rowToSession(row: SessionRow, childSlugs: string[] = []): Session {
  const pr: PRSummary | undefined =
    row.pr_number != null && row.pr_url && row.pr_state && row.pr_base && row.pr_head && row.pr_title
      ? {
          number: row.pr_number,
          url: row.pr_url,
          state: row.pr_state as "open" | "closed" | "merged",
          draft: row.pr_draft === 1,
          base: row.pr_base,
          head: row.pr_head,
          title: row.pr_title,
        }
      : undefined;

  const stats: SessionStats = {
    turns: row.stats_turns,
    inputTokens: row.stats_input_tokens,
    outputTokens: row.stats_output_tokens,
    cacheReadTokens: row.stats_cache_read_tokens,
    cacheCreationTokens: row.stats_cache_creation_tokens,
    costUsd: row.stats_cost_usd,
    durationMs: row.stats_duration_ms,
    toolCalls: row.stats_tool_calls,
  };

  return {
    slug: row.slug,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode as SessionMode,
    status: row.status as SessionStatus,
    shipStage: row.ship_stage ? (row.ship_stage as ShipStage) : undefined,
    repoId: row.repo_id ?? undefined,
    branch: row.branch ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    parentSlug: row.parent_slug ?? undefined,
    rootSlug: row.root_slug ?? undefined,
    childSlugs,
    pr,
    attention: JSON.parse(row.attention) as AttentionFlag[],
    quickActions: JSON.parse(row.quick_actions) as QuickAction[],
    stats,
    provider: row.provider,
    modelHint: row.model_hint ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    lastTurnAt: row.last_turn_at ?? undefined,
    dagId: row.dag_id ?? undefined,
    dagNodeId: row.dag_node_id ?? undefined,
    loopId: row.loop_id ?? undefined,
    variantOf: row.variant_of ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export function sessionToRow(s: Session): SessionRow {
  return {
    slug: s.slug,
    title: s.title,
    prompt: s.prompt,
    mode: s.mode,
    status: s.status,
    ship_stage: s.shipStage ?? null,
    repo_id: s.repoId ?? null,
    branch: s.branch ?? null,
    base_branch: s.baseBranch ?? null,
    worktree_path: s.worktreePath ?? null,
    parent_slug: s.parentSlug ?? null,
    root_slug: s.rootSlug ?? null,
    pr_number: s.pr?.number ?? null,
    pr_url: s.pr?.url ?? null,
    pr_state: s.pr?.state ?? null,
    pr_draft: s.pr?.draft ? 1 : 0,
    pr_base: s.pr?.base ?? null,
    pr_head: s.pr?.head ?? null,
    pr_title: s.pr?.title ?? null,
    attention: JSON.stringify(s.attention),
    quick_actions: JSON.stringify(s.quickActions),
    stats_turns: s.stats.turns,
    stats_input_tokens: s.stats.inputTokens,
    stats_output_tokens: s.stats.outputTokens,
    stats_cache_read_tokens: s.stats.cacheReadTokens,
    stats_cache_creation_tokens: s.stats.cacheCreationTokens,
    stats_cost_usd: s.stats.costUsd,
    stats_duration_ms: s.stats.durationMs,
    stats_tool_calls: s.stats.toolCalls,
    provider: s.provider,
    model_hint: s.modelHint ?? null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    started_at: s.startedAt ?? null,
    completed_at: s.completedAt ?? null,
    last_turn_at: s.lastTurnAt ?? null,
    dag_id: s.dagId ?? null,
    dag_node_id: s.dagNodeId ?? null,
    loop_id: s.loopId ?? null,
    variant_of: s.variantOf ?? null,
    metadata: JSON.stringify(s.metadata),
  };
}

export function rowToTranscriptEvent(row: TranscriptRow): TranscriptEvent {
  const body = JSON.parse(row.body) as Record<string, unknown>;
  const base = {
    id: row.id,
    sessionSlug: row.session_slug,
    seq: row.seq,
    turn: row.turn,
    timestamp: row.timestamp,
  };

  const kind = row.kind as TranscriptEventKind;

  switch (kind) {
    case "user_message":
      return {
        ...base,
        kind: "user_message",
        text: body["text"] as string,
        attachments: body["attachments"] as UserMessageEvent["attachments"],
        source: body["source"] as UserMessageEvent["source"],
        injected: body["injected"] as boolean | undefined,
      } satisfies UserMessageEvent;
    case "turn_started":
      return {
        ...base,
        kind: "turn_started",
        reason: body["reason"] as TurnStartedEvent["reason"],
      } satisfies TurnStartedEvent;
    case "turn_completed":
      return {
        ...base,
        kind: "turn_completed",
        outcome: body["outcome"] as TurnCompletedEvent["outcome"],
        stopReason: body["stopReason"] as string | undefined,
      } satisfies TurnCompletedEvent;
    case "assistant_text":
      return {
        ...base,
        kind: "assistant_text",
        text: body["text"] as string,
        partial: body["partial"] as boolean | undefined,
      } satisfies AssistantTextEvent;
    case "thinking":
      return {
        ...base,
        kind: "thinking",
        text: body["text"] as string,
      } satisfies ThinkingEvent;
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        toolCallId: body["toolCallId"] as string,
        toolName: body["toolName"] as string,
        toolKind: body["toolKind"] as ToolKind,
        summary: body["summary"] as string,
        input: body["input"] as Record<string, unknown>,
      } satisfies ToolCallEvent;
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        toolCallId: body["toolCallId"] as string,
        toolName: body["toolName"] as string | undefined,
        toolKind: body["toolKind"] as ToolKind | undefined,
        status: body["status"] as ToolResultStatus,
        format: (body["format"] as ToolResultFormat | undefined) ?? "text",
        body: body["body"] as string,
        truncated: body["truncated"] as boolean | undefined,
        byteSize: body["byteSize"] as number | undefined,
      } satisfies ToolResultEvent;
    case "status":
      return {
        ...base,
        kind: "status",
        level: body["level"] as StatusEvent["level"],
        text: body["text"] as string,
        data: body["data"] as Record<string, unknown> | undefined,
      } satisfies StatusEvent;
    default: {
      const exhausted: never = kind;
      throw new Error(`Unknown transcript event kind: ${String(exhausted)}`);
    }
  }
}

function classifyToolKind(toolName: string): ToolKind {
  const name = toolName.toLowerCase();
  if (name.includes("read") || name.includes("view")) return "read";
  if (name.includes("write") || name.includes("create")) return "write";
  if (name.includes("edit") || name.includes("str_replace") || name.includes("patch")) return "edit";
  if (name.includes("bash") || name.includes("shell") || name.includes("run") || name.includes("exec")) return "shell";
  if (name.includes("grep") || name.includes("search") || name.includes("find") || name.includes("ripgrep")) return "search";
  if (name.includes("glob")) return "glob";
  if (name.includes("web") || name.includes("fetch") || name.includes("url")) return "web";
  if (name.includes("browser") || name.includes("screenshot")) return "browser";
  if (name.includes("notebook")) return "notebook";
  if (name.includes("mcp")) return "mcp";
  if (name.includes("todo")) return "todo";
  return "other";
}

export function eventToRow(
  slug: string,
  id: string,
  seq: number,
  turn: number,
  timestamp: string,
  ev: ProviderEvent,
): TranscriptRow | null {
  let kind: TranscriptEventKind;
  let body: Record<string, unknown>;

  switch (ev.kind) {
    case "assistant_text":
      kind = "assistant_text";
      body = { text: ev.text, partial: ev.partial };
      break;
    case "thinking":
      kind = "thinking";
      body = { text: ev.text };
      break;
    case "tool_call": {
      kind = "tool_call";
      const toolKind = classifyToolKind(ev.toolName);
      body = {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        toolKind,
        summary: `${ev.toolName}(${Object.keys(ev.input).join(", ")})`,
        input: ev.input,
      };
      break;
    }
    case "tool_result":
      kind = "tool_result";
      body = {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        status: ev.status,
        format: "text",
        body: ev.body,
        truncated: ev.truncated,
        byteSize: ev.body.length,
      };
      break;
    case "turn_started":
      kind = "turn_started";
      body = { reason: "resume" };
      break;
    case "turn_completed":
      kind = "turn_completed";
      body = { outcome: ev.outcome, stopReason: ev.stopReason };
      break;
    case "status":
      kind = "status";
      body = { level: ev.level, text: ev.text, data: ev.data };
      break;
    case "session_id":
      return null;
    default: {
      const exhausted: never = ev;
      throw new Error(`Unknown provider event kind: ${String((exhausted as ProviderEvent).kind)}`);
    }
  }

  return {
    id,
    session_slug: slug,
    seq,
    turn,
    kind,
    body: JSON.stringify(body),
    timestamp,
  };
}
