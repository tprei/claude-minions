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

function normalizeParsedDag(value: unknown): ParsedDag | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj["title"] !== "string") return null;
  if (typeof obj["goal"] !== "string") return null;
  if (!Array.isArray(obj["nodes"]) || obj["nodes"].length === 0) return null;

  const titles = new Set<string>();
  const nodes: ParsedDagNode[] = [];

  for (const n of obj["nodes"] as unknown[]) {
    if (typeof n !== "object" || n === null) return null;
    const node = n as Record<string, unknown>;
    if (typeof node["title"] !== "string" || node["title"].trim().length === 0) return null;
    if (typeof node["prompt"] !== "string" || node["prompt"].trim().length === 0) return null;
    if (titles.has(node["title"])) return null;
    titles.add(node["title"]);

    let dependsOn: string[] = [];
    if (node["dependsOn"] !== undefined) {
      if (!Array.isArray(node["dependsOn"])) return null;
      if (node["dependsOn"].some((dep) => typeof dep !== "string")) return null;
      dependsOn = node["dependsOn"] as string[];
      if (dependsOn.length > 1) return null;
    }

    nodes.push({
      title: node["title"],
      prompt: node["prompt"],
      dependsOn,
    });
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!titles.has(dep)) return null;
    }
  }

  if (hasCycle(nodes)) return null;

  return {
    title: obj["title"],
    goal: obj["goal"],
    nodes,
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
  for (const event of [...events].reverse()) {
    if (event.kind !== "assistant_text") continue;
    const blocks = extractDagBlocks(event.text);
    for (const block of blocks.reverse()) {
      const parsed = tryParseJson(block);
      const normalized = normalizeParsedDag(parsed);
      if (!normalized) continue;
      return normalized;
    }
  }
  return null;
}
