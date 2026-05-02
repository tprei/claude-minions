import type { TranscriptEvent } from "@minions/shared";

export interface ParsedDagNode {
  title: string;
  prompt: string;
  dependsOn: string[];
}

export interface ParsedDag {
  title: string;
  goal: string;
  nodes: ParsedDagNode[];
}

const DAG_FENCE_OPEN_RE = /```dag[ \t]*\r?\n/g;

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type NormalizeResult =
  | { kind: "ok"; dag: ParsedDag }
  | { kind: "error"; reason: string };

function normalizeParsedDag(value: unknown): NormalizeResult {
  if (typeof value !== "object" || value === null) {
    return { kind: "error", reason: "block body is not a JSON object" };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj["title"] !== "string") {
    return { kind: "error", reason: "missing or non-string `title` at the top level" };
  }
  if (typeof obj["goal"] !== "string") {
    return { kind: "error", reason: "missing or non-string `goal` at the top level" };
  }
  if (!Array.isArray(obj["nodes"]) || obj["nodes"].length === 0) {
    return { kind: "error", reason: "`nodes` must be a non-empty array" };
  }

  const titles = new Set<string>();
  const nodes: ParsedDagNode[] = [];

  for (let i = 0; i < (obj["nodes"] as unknown[]).length; i++) {
    const n = (obj["nodes"] as unknown[])[i];
    if (typeof n !== "object" || n === null) {
      return { kind: "error", reason: `nodes[${i}] is not an object` };
    }
    const node = n as Record<string, unknown>;
    if (typeof node["title"] !== "string" || node["title"].trim().length === 0) {
      return { kind: "error", reason: `nodes[${i}] has missing or empty \`title\`` };
    }
    if (typeof node["prompt"] !== "string" || node["prompt"].trim().length === 0) {
      return { kind: "error", reason: `node \`${node["title"]}\` has missing or empty \`prompt\`` };
    }
    if (titles.has(node["title"] as string)) {
      return { kind: "error", reason: `duplicate node title \`${node["title"]}\`` };
    }
    titles.add(node["title"] as string);

    let dependsOn: string[] = [];
    if (node["dependsOn"] !== undefined) {
      if (!Array.isArray(node["dependsOn"])) {
        return { kind: "error", reason: `node \`${node["title"]}\`.dependsOn must be an array` };
      }
      if (node["dependsOn"].some((dep) => typeof dep !== "string")) {
        return {
          kind: "error",
          reason: `node \`${node["title"]}\`.dependsOn must contain only strings`,
        };
      }
      dependsOn = node["dependsOn"] as string[];
    }

    nodes.push({
      title: node["title"] as string,
      prompt: node["prompt"] as string,
      dependsOn,
    });
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!titles.has(dep)) {
        return {
          kind: "error",
          reason: `node \`${node.title}\` depends on unknown node \`${dep}\``,
        };
      }
    }
  }

  if (hasCycle(nodes)) {
    return { kind: "error", reason: "cycle detected in the dependency graph" };
  }

  return {
    kind: "ok",
    dag: {
      title: obj["title"] as string,
      goal: obj["goal"] as string,
      nodes,
    },
  };
}

function hasCycle(nodes: ParsedDagNode[]): boolean {
  const byTitle = new Map(nodes.map((node) => [node.title, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(title: string): boolean {
    if (visited.has(title)) return false;
    if (visiting.has(title)) return true;
    visiting.add(title);
    const node = byTitle.get(title);
    if (node) {
      for (const dep of node.dependsOn) {
        if (visit(dep)) return true;
      }
    }
    visiting.delete(title);
    visited.add(title);
    return false;
  }

  return nodes.some((node) => visit(node.title));
}

function findJsonObjectEnd(text: string, startIndex: number): number | null {
  if (text[startIndex] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

export function extractDagBlocks(text: string): string[] {
  const blocks: string[] = [];
  DAG_FENCE_OPEN_RE.lastIndex = 0;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = DAG_FENCE_OPEN_RE.exec(text)) !== null) {
    const afterOpen = openMatch.index + openMatch[0].length;
    let i = afterOpen;
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) i++;
    if (text[i] !== "{") continue;
    const objEnd = findJsonObjectEnd(text, i);
    if (objEnd === null) continue;
    let j = objEnd;
    while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) j++;
    if (text.slice(j, j + 3) !== "```") continue;
    blocks.push(text.slice(i, objEnd));
    DAG_FENCE_OPEN_RE.lastIndex = j + 3;
  }
  return blocks;
}

export function parseDagFromTranscript(events: TranscriptEvent[]): ParsedDag | null {
  const result = parseDagFromTranscriptDetailed(events);
  return result.kind === "ok" ? result.dag : null;
}

export type ParseDagDetailedResult =
  | { kind: "ok"; dag: ParsedDag }
  | { kind: "error"; reason: string; block: string }
  | { kind: "no-blocks" };

/**
 * Like `parseDagFromTranscript` but surfaces *why* parsing failed and which
 * block was rejected. Used by ship-coordinator and dag-subsystem to emit
 * actionable feedback to the agent (e.g. cycle in deps, unknown dep, duplicate
 * title) instead of silently failing the plan→dag advance.
 *
 * Returns the LAST rejected block's reason if no block parsed successfully —
 * matches the same "prefer most-recent" precedence as `parseDagFromTranscript`.
 */
export function parseDagFromTranscriptDetailed(
  events: TranscriptEvent[],
): ParseDagDetailedResult {
  let firstError: { reason: string; block: string } | null = null;
  let sawAnyBlock = false;

  for (const event of [...events].reverse()) {
    if (event.kind !== "assistant_text") continue;
    const blocks = extractDagBlocks(event.text);
    for (const block of blocks.reverse()) {
      sawAnyBlock = true;
      const parsed = tryParseJson(block);
      if (parsed === null) {
        if (!firstError) firstError = { reason: "block body is not valid JSON", block };
        continue;
      }
      const normalized = normalizeParsedDag(parsed);
      if (normalized.kind === "ok") return { kind: "ok", dag: normalized.dag };
      if (!firstError) firstError = { reason: normalized.reason, block };
    }
  }

  if (firstError) return { kind: "error", reason: firstError.reason, block: firstError.block };
  if (sawAnyBlock) return { kind: "error", reason: "no valid dag block found", block: "" };
  return { kind: "no-blocks" };
}
