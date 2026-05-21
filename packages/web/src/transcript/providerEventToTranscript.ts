// Converts a ProviderEvent (from the engine's workflow SSE stream) into a
// TranscriptEvent (the shape the Transcript renderer expects).
//
// ProviderEvent and TranscriptEvent are shared contracts from @minions/shared.
//
// Mapping notes:
//   assistant_text → AssistantTextEvent  (direct)
//   thinking       → ThinkingEvent       (direct)
//   tool_call      → ToolCallEvent       (provider-specific tool names/inputs normalized to the
//                                         transcript contract; toolKind inferred from the live payload)
//   tool_result    → ToolResultEvent     (structured outputs flattened for display instead of
//                                         dumping raw provider envelopes)
//   usage          → UsageEvent          (token accounting preserved in the transcript)
//   final          → null (session bookkeeping, not displayed)
//   error          → StatusEvent (level "error", text from message)
//   permission_request → null (not currently displayed)

import type {
  ProviderEvent,
  ToolKind,
  ToolResultEvent,
  TranscriptEvent,
} from "@minions/shared";

let seq = 0;
const toolCallMeta = new Map<string, { toolName: string; toolKind: ToolKind }>();
const DATA_IMAGE_RE =
  /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const IMAGE_URL_RE =
  /^https?:\/\/.+\.(?:png|jpeg|jpg|gif|webp)(?:[?#].*)?$/i;

function nextSeq(): number {
  return ++seq;
}

function syntheticId(kind: string): string {
  return `${kind}-${Date.now()}-${nextSeq()}`;
}

function toolMetaKey(sessionSlug: string, turn: number, toolCallId: string): string {
  return `${sessionSlug}:${turn}:${toolCallId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value, null, 2);
  return json ?? String(value);
}

function detectStringFormat(body: string): ToolResultEvent["format"] {
  const trimmed = body.trim();
  if (DATA_IMAGE_RE.test(trimmed) || IMAGE_URL_RE.test(trimmed)) return "image";
  return "text";
}

function extractImageSource(record: Record<string, unknown>): string | null {
  const source = record["source"];
  if (typeof source === "string") return source;
  const sourceRecord = asRecord(source);
  if (
    sourceRecord &&
    typeof sourceRecord["media_type"] === "string" &&
    sourceRecord["media_type"].startsWith("image/") &&
    typeof sourceRecord["data"] === "string"
  ) {
    return `data:${sourceRecord["media_type"]};base64,${sourceRecord["data"]}`;
  }
  const imageUrlRecord = asRecord(record["image_url"]);
  return typeof imageUrlRecord?.["url"] === "string" ? imageUrlRecord["url"] : null;
}

function normalizeStructuredBlocks(
  blocks: unknown[],
): Pick<ToolResultEvent, "format" | "body"> | null {
  const textSegments: string[] = [];
  const imageSources: string[] = [];

  for (const block of blocks) {
    if (typeof block === "string") {
      if (block.length > 0) textSegments.push(block);
      continue;
    }

    const record = asRecord(block);
    if (!record) continue;

    if (record["type"] === "text" && typeof record["text"] === "string") {
      textSegments.push(record["text"]);
      continue;
    }

    const imageSource = extractImageSource(record);
    if (imageSource) imageSources.push(imageSource);
  }

  if (textSegments.length > 0) {
    return {
      format: "text",
      body: textSegments.join("\n\n"),
    };
  }

  if (imageSources.length === 1) {
    return {
      format: "image",
      body: imageSources[0]!,
    };
  }

  return null;
}

function normalizeToolResultContent(
  content: unknown,
): Pick<ToolResultEvent, "format" | "body"> | null {
  if (typeof content === "string") {
    return {
      format: detectStringFormat(content),
      body: content,
    };
  }
  if (Array.isArray(content)) return normalizeStructuredBlocks(content);
  return null;
}

function messageOnly(record: Record<string, unknown>): string | null {
  return Object.keys(record).length === 1 && typeof record["message"] === "string"
    ? record["message"]
    : null;
}

function normalizeToolResultEnvelope(
  record: Record<string, unknown>,
): Pick<ToolResultEvent, "format" | "body"> | null {
  const content = normalizeToolResultContent(record["content"]);
  if (content) return content;

  if (record["structured_content"] !== undefined && record["structured_content"] !== null) {
    return {
      format: "json",
      body: stringifyUnknown(record["structured_content"]),
    };
  }

  const message = messageOnly(record);
  if (message !== null) {
    return {
      format: "text",
      body: message,
    };
  }

  return null;
}

function normalizeToolResultOutput(
  output: unknown,
): Pick<ToolResultEvent, "format" | "body"> {
  const content = normalizeToolResultContent(output);
  if (content) return content;

  if (Array.isArray(output)) {
    return {
      format: "json",
      body: stringifyUnknown(output),
    };
  }

  const record = asRecord(output);
  if (record) {
    const envelope = normalizeToolResultEnvelope(record);
    if (envelope) return envelope;

    return {
      format: "json",
      body: stringifyUnknown(record),
    };
  }

  return {
    format: "text",
    body: stringifyUnknown(output),
  };
}

function inferToolKind(name: string, input: unknown): ToolKind {
  const normalized = name.trim().toLowerCase();
  if (
    normalized === "command_execution" ||
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "exec_command"
  ) {
    return "shell";
  }
  if (normalized === "read" || normalized === "read_file" || normalized.startsWith("read_")) {
    return "read";
  }
  if (
    normalized === "write" ||
    normalized === "write_file" ||
    normalized === "create_file" ||
    normalized.startsWith("write_")
  ) {
    return "write";
  }
  if (
    normalized === "edit" ||
    normalized === "file_change" ||
    normalized === "str_replace_editor" ||
    normalized === "replace_in_file" ||
    normalized.includes("patch")
  ) {
    return "edit";
  }
  if (normalized === "glob" || normalized === "find_files") return "glob";
  if (
    normalized === "grep" ||
    normalized === "search_files" ||
    normalized === "find_in_file"
  ) {
    return "search";
  }
  if (normalized === "web_search" || normalized === "web_fetch" || normalized.startsWith("web_")) {
    return "web";
  }
  if (
    normalized.startsWith("browser") ||
    normalized.includes("playwright") ||
    normalized.includes("chrome")
  ) {
    return "browser";
  }
  if (normalized.includes("notebook") || normalized.includes("jupyter")) return "notebook";
  if (normalized === "todo" || normalized === "todo_write" || normalized === "todowrite") {
    return "todo";
  }
  if (normalized.startsWith("mcp_")) return "mcp";

  const record = asRecord(input);
  if (!record) return "other";
  if (record["changes"] !== undefined) return "edit";
  if (typeof record["command"] === "string" || Array.isArray(record["command"])) return "shell";
  if (typeof record["pattern"] === "string") return normalized.includes("glob") ? "glob" : "search";
  if (typeof record["query"] === "string") return "web";
  if (typeof record["text"] === "string" || typeof record["content"] === "string") return "write";
  if (typeof record["file_path"] === "string" || typeof record["path"] === "string") return "read";
  return "other";
}

function titleCase(name: string): string {
  return name
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

function canonicalToolName(toolKind: ToolKind, rawName: string): string {
  switch (toolKind) {
    case "shell":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "glob":
      return "Glob";
    case "search":
      return "Grep";
    case "web":
      return rawName.trim().toLowerCase().includes("fetch") ? "WebFetch" : "WebSearch";
    case "browser":
      return "Browser";
    case "notebook":
      return "Notebook";
    case "todo":
      return "TodoWrite";
    default:
      return rawName.trim().length > 0 ? titleCase(rawName.trim()) : "Tool";
  }
}

function firstChangePath(changes: unknown): string | null {
  if (!Array.isArray(changes)) return null;
  for (const change of changes) {
    const record = asRecord(change);
    if (typeof record?.["path"] === "string") return record["path"];
  }
  return null;
}

function normalizeShellInput(input: unknown): Record<string, unknown> {
  if (Array.isArray(input)) {
    return {
      command: input.map((part) => String(part)).join(" "),
    };
  }
  const record = asRecord(input);
  if (!record) return {};
  if (Array.isArray(record["command"])) {
    return {
      ...record,
      command: record["command"].map((part) => String(part)).join(" "),
    };
  }
  return record;
}

function normalizePathInput(input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  if (!record) return {};
  const filePath =
    typeof record["file_path"] === "string"
      ? record["file_path"]
      : typeof record["path"] === "string"
        ? record["path"]
        : firstChangePath(record["changes"]);
  return filePath ? { ...record, file_path: filePath } : record;
}

function normalizeSearchInput(input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  if (!record) return {};
  const pattern =
    typeof record["pattern"] === "string"
      ? record["pattern"]
      : typeof record["query"] === "string"
        ? record["query"]
        : undefined;
  return pattern ? { ...record, pattern } : record;
}

function normalizeToolInput(toolKind: ToolKind, input: unknown): Record<string, unknown> {
  switch (toolKind) {
    case "shell":
      return normalizeShellInput(input);
    case "read":
    case "write":
    case "edit":
      return normalizePathInput(input);
    case "search":
      return normalizeSearchInput(input);
    default:
      return asRecord(input) ?? {};
  }
}

export function providerEventToTranscript(
  event: ProviderEvent,
  sessionSlug: string,
  turn: number,
  timestamp: string,
): TranscriptEvent | null {
  const base = { sessionSlug, turn, timestamp };

  switch (event.kind) {
    case "assistant_text":
      return {
        ...base,
        kind: "assistant_text",
        id: syntheticId("assistant_text"),
        seq: nextSeq(),
        text: event.text,
      };

    case "thinking":
      return {
        ...base,
        kind: "thinking",
        id: syntheticId("thinking"),
        seq: nextSeq(),
        text: event.text,
      };

    case "tool_call": {
      const toolKind = inferToolKind(event.name, event.input);
      const toolName = canonicalToolName(toolKind, event.name);
      const toolCallInput = normalizeToolInput(toolKind, event.input);
      toolCallMeta.set(toolMetaKey(sessionSlug, turn, event.id), { toolName, toolKind });
      return {
        ...base,
        kind: "tool_call",
        id: syntheticId("tool_call"),
        seq: nextSeq(),
        toolCallId: event.id,
        toolName,
        toolKind,
        summary: toolName,
        input: toolCallInput,
      };
    }

    case "tool_result": {
      const meta = toolCallMeta.get(toolMetaKey(sessionSlug, turn, event.id));
      const normalizedResult = normalizeToolResultOutput(event.output);
      return {
        ...base,
        kind: "tool_result",
        id: syntheticId("tool_result"),
        seq: nextSeq(),
        toolCallId: event.id,
        ...(meta ? { toolName: meta.toolName, toolKind: meta.toolKind } : {}),
        status: event.isError === true ? "error" : "ok",
        format: normalizedResult.format,
        body: normalizedResult.body,
      };
    }

    case "error":
      return {
        ...base,
        kind: "status",
        id: syntheticId("status"),
        seq: nextSeq(),
        level: "error",
        text: event.message,
        ...(event.source !== undefined ? { data: { source: event.source } } : {}),
      };

    case "usage":
      return {
        ...base,
        kind: "usage",
        id: syntheticId("usage"),
        seq: nextSeq(),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.cachedInputTokens !== undefined
          ? { cachedInputTokens: event.cachedInputTokens }
          : {}),
        ...(event.reasoningTokens !== undefined
          ? { reasoningTokens: event.reasoningTokens }
          : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      };

    case "final":
    case "permission_request":
      return null;
  }
}
