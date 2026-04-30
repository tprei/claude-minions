import type {
  AssistantTextEvent,
  DiffStat,
  Session,
  ToolCallEvent,
  ToolResultEvent,
  TranscriptEvent,
  WorkspaceDiff,
} from "@minions/shared";

export interface BuildPrBodyArgs {
  session: Session;
  diff: WorkspaceDiff;
  transcript: TranscriptEvent[];
  parentPr: { number: number; url: string; parentTitle: string } | null;
  webBaseUrl: string;
}

const MAX_WHAT_FILES = 20;
const APPROACH_HEADING_LIMIT = 600;
const APPROACH_TAIL_LIMIT = 400;
const VERIFICATION_OUTPUT_LIMIT = 600;
const TEST_FILE_REGEX = /\.(test|spec)\.[a-z]+$/;
const VERIFICATION_COMMAND_REGEX =
  /(npm|pnpm|yarn) (test|run test|run typecheck|typecheck)|^tsc\b|vitest|jest/i;

export function buildPrBody(args: BuildPrBodyArgs): string {
  const { session, diff, transcript, parentPr, webBaseUrl } = args;
  const sections: string[] = [];

  const why = renderWhy(session);
  if (why) sections.push(why);

  const what = renderWhat(diff.stats);
  if (what) sections.push(what);

  const approach = renderApproach(transcript);
  if (approach) sections.push(approach);

  const verification = renderVerification(diff.stats, transcript);
  if (verification) sections.push(verification);

  sections.push(renderSession(session, webBaseUrl));

  let body = sections.join("\n\n");
  if (parentPr) {
    body = `Stacks on: PR #${parentPr.number} (${parentPr.parentTitle})\n\n${body}`;
  }
  return body;
}

function renderWhy(session: Session): string {
  const fromPrompt = firstNonEmptyParagraph(session.prompt);
  const text = fromPrompt ?? session.title;
  if (!text) return "";
  return `## Why\n\n${text}`;
}

function firstNonEmptyParagraph(text: string | undefined | null): string | null {
  if (!text) return null;
  const paragraphs = text.split("\n\n");
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function renderWhat(stats: DiffStat[]): string {
  if (!stats || stats.length === 0) return "";
  const sorted = [...stats].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );
  const shown = sorted.slice(0, MAX_WHAT_FILES);
  const lines = shown.map(
    (s) => `- \`${s.path}\` (+${s.additions} / -${s.deletions})`,
  );
  if (sorted.length > MAX_WHAT_FILES) {
    const more = sorted.length - MAX_WHAT_FILES;
    lines.push(`- …and ${more} more files`);
  }
  return `## What\n\n${lines.join("\n")}`;
}

function renderApproach(transcript: TranscriptEvent[]): string {
  const assistantTexts = transcript.filter(
    (e): e is AssistantTextEvent => e.kind === "assistant_text" && !e.partial,
  );
  if (assistantTexts.length === 0) return "";

  for (const evt of assistantTexts) {
    const section = extractHeadingSection(evt.text, ["Approach", "Plan"]);
    if (section) {
      return `## Approach\n\n${truncate(section, APPROACH_HEADING_LIMIT)}`;
    }
  }

  const toolCallSeqs = transcript
    .filter((e): e is ToolCallEvent => e.kind === "tool_call")
    .map((e) => e.seq);
  const maxToolCallSeq = toolCallSeqs.length > 0 ? Math.max(...toolCallSeqs) : null;

  const candidates =
    maxToolCallSeq === null
      ? assistantTexts
      : assistantTexts.filter((e) => e.seq < maxToolCallSeq);
  const last = candidates[candidates.length - 1];
  if (!last) return "";
  const trimmed = last.text.trim();
  if (!trimmed) return "";
  return `## Approach\n\n${truncate(trimmed, APPROACH_TAIL_LIMIT)}`;
}

function extractHeadingSection(text: string, headings: string[]): string | null {
  const lines = text.split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = /^##\s+(.+)$/.exec(line);
    if (!match) continue;
    const headingText = (match[1] ?? "").trim();
    if (headings.some((h) => headingText.toLowerCase() === h.toLowerCase())) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;
  const sectionLines: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s+/.test(line)) break;
    sectionLines.push(line);
  }
  const result = sectionLines.join("\n").trim();
  return result.length > 0 ? result : null;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function renderVerification(
  stats: DiffStat[],
  transcript: TranscriptEvent[],
): string {
  const bullets: string[] = [];

  const testPaths = stats
    .filter((s) => TEST_FILE_REGEX.test(s.path))
    .map((s) => s.path);
  if (testPaths.length > 0) {
    bullets.push(`- Tests touched: ${testPaths.join(", ")}`);
  }

  const verificationOutput = findVerificationOutput(transcript);
  if (verificationOutput) {
    bullets.push(
      `- Last test/typecheck output:\n\n\`\`\`\n${verificationOutput}\n\`\`\``,
    );
  }

  if (bullets.length === 0) return "";
  return `## Verification\n\n${bullets.join("\n")}`;
}

function findVerificationOutput(transcript: TranscriptEvent[]): string | null {
  const toolCallsById = new Map<string, ToolCallEvent>();
  for (const evt of transcript) {
    if (evt.kind === "tool_call") {
      toolCallsById.set(evt.toolCallId, evt);
    }
  }

  const matches: ToolResultEvent[] = [];
  for (const evt of transcript) {
    if (evt.kind !== "tool_result") continue;
    const call = toolCallsById.get(evt.toolCallId);
    if (!call) continue;
    if (call.toolKind !== "shell") continue;
    const command = typeof call.input?.command === "string" ? call.input.command : "";
    if (!VERIFICATION_COMMAND_REGEX.test(command)) continue;
    matches.push(evt);
  }
  if (matches.length === 0) return null;

  const okResults = matches.filter((m) => m.status === "ok");
  const pool = okResults.length > 0 ? okResults : matches.filter((m) => m.status === "error");
  const last = pool[pool.length - 1];
  if (!last) return null;
  return truncate(last.body.trim(), VERIFICATION_OUTPUT_LIMIT);
}

function renderSession(session: Session, webBaseUrl: string): string {
  const branch = session.branch ?? "(none)";
  return [
    "## Session",
    "",
    `- Slug: \`${session.slug}\` (branch \`${branch}\`)`,
    `- Local UI: ${webBaseUrl}/c/local/chat/${session.slug}`,
  ].join("\n");
}
