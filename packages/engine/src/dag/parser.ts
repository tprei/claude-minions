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

const DAG_FENCE_RE = /```dag\s*\n([\s\S]*?)```/g;

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const unescaped = raw
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
    try {
      return JSON.parse(unescaped);
    } catch {
      return null;
    }
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

export function parseDagFromTranscript(events: TranscriptEvent[]): ParsedDag | null {
  for (const event of events) {
    if (event.kind !== "assistant_text") continue;
    const text = event.text;
    DAG_FENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DAG_FENCE_RE.exec(text)) !== null) {
      const block = match[1];
      if (!block) continue;
      const parsed = tryParseJson(block.trim());
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
