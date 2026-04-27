import type { TranscriptEvent } from "@minions/shared";

const MAX_TEXT_BYTES = 4096;
const TRUNCATION_SUFFIX = "...truncated";

// TODO(T33): once the web package gains a test runner, add unit coverage for
// truncation, empty-field stripping, and the rendered markdown shape.

function truncateString(value: string): string {
  if (typeof TextEncoder === "undefined") {
    if (value.length <= MAX_TEXT_BYTES) return value;
    return value.slice(0, MAX_TEXT_BYTES) + TRUNCATION_SUFFIX;
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_TEXT_BYTES) return value;
  const head = bytes.slice(0, MAX_TEXT_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(head) + TRUNCATION_SUFFIX;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return true;
  return false;
}

function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = value.map((v) => compact(v)).filter((v) => !isEmpty(v));
    return arr;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const next = compact(raw);
      if (!isEmpty(next)) out[key] = next;
    }
    return out;
  }
  if (typeof value === "string") return truncateString(value);
  return value;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return `${n}`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

export function copyAsMarkdown(events: TranscriptEvent[]): string {
  const blocks: string[] = [];
  for (const event of events) {
    const time = formatTimestamp(event.timestamp);
    const compacted = compact(event) as Record<string, unknown>;
    const json = JSON.stringify(compacted, null, 2);
    blocks.push(`## [${time}] kind=${event.kind} seq=${event.seq}\n\`\`\`json\n${json}\n\`\`\``);
  }
  return blocks.join("\n\n");
}
