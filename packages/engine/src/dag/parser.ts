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

function isValidParsedDag(value: unknown): value is ParsedDag {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["title"] !== "string") return false;
  if (typeof obj["goal"] !== "string") return false;
  if (!Array.isArray(obj["nodes"])) return false;
  for (const n of obj["nodes"] as unknown[]) {
    if (typeof n !== "object" || n === null) return false;
    const node = n as Record<string, unknown>;
    if (typeof node["title"] !== "string") return false;
    if (typeof node["prompt"] !== "string") return false;
    if (node["dependsOn"] !== undefined && !Array.isArray(node["dependsOn"])) return false;
  }
  return true;
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
  for (const event of events) {
    if (event.kind !== "assistant_text") continue;
    const blocks = extractDagBlocks(event.text);
    for (const block of blocks) {
      const parsed = tryParseJson(block);
      if (!isValidParsedDag(parsed)) continue;
      return {
        title: parsed.title,
        goal: parsed.goal,
        nodes: parsed.nodes.map((n) => ({
          title: n.title,
          prompt: n.prompt,
          dependsOn: Array.isArray(n.dependsOn) ? (n.dependsOn as string[]) : [],
        })),
      };
    }
  }
  return null;
}
