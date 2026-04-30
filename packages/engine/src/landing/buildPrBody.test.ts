import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type {
  DiffStat,
  Session,
  TranscriptEvent,
  WorkspaceDiff,
} from "@minions/shared";
import { buildPrBody } from "./buildPrBody.js";

const WEB_BASE_URL = "http://localhost:8787";

function buildSession(slug: string, overrides: Partial<Session> = {}): Session {
  return {
    slug,
    title: slug,
    prompt: "do work",
    mode: "task",
    status: "running",
    attention: [],
    quickActions: [],
    branch: `minions/${slug}`,
    baseBranch: "main",
    worktreePath: `/tmp/worktrees/${slug}`,
    repoId: "repo-1",
    stats: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
    provider: "mock",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    childSlugs: [],
    metadata: {},
    ...overrides,
  };
}

function buildDiff(stats: DiffStat[], overrides: Partial<WorkspaceDiff> = {}): WorkspaceDiff {
  return {
    sessionSlug: "slug",
    patch: "",
    stats,
    truncated: false,
    byteSize: 0,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function diffStat(path: string, additions: number, deletions: number): DiffStat {
  return { path, additions, deletions, status: "modified" };
}

interface AssistantTextOpts {
  seq: number;
  text: string;
  partial?: boolean;
}

function assistantText(opts: AssistantTextOpts): TranscriptEvent {
  return {
    kind: "assistant_text",
    id: `at-${opts.seq}`,
    sessionSlug: "slug",
    seq: opts.seq,
    turn: 0,
    timestamp: new Date().toISOString(),
    text: opts.text,
    partial: opts.partial,
  };
}

function shellToolCall(opts: { seq: number; toolCallId: string; command: string; toolName?: string }): TranscriptEvent {
  return {
    kind: "tool_call",
    id: `tc-${opts.seq}`,
    sessionSlug: "slug",
    seq: opts.seq,
    turn: 0,
    timestamp: new Date().toISOString(),
    toolCallId: opts.toolCallId,
    toolName: opts.toolName ?? "Bash",
    toolKind: "shell",
    summary: opts.command,
    input: { command: opts.command },
  };
}

function toolResult(opts: {
  seq: number;
  toolCallId: string;
  body: string;
  status?: "ok" | "error" | "partial";
}): TranscriptEvent {
  return {
    kind: "tool_result",
    id: `tr-${opts.seq}`,
    sessionSlug: "slug",
    seq: opts.seq,
    turn: 0,
    timestamp: new Date().toISOString(),
    toolCallId: opts.toolCallId,
    status: opts.status ?? "ok",
    format: "text",
    body: opts.body,
  };
}

describe("buildPrBody", () => {
  test("full input happy path renders all five sections in order", () => {
    const session = buildSession("alpha", {
      prompt: "Implement widget filtering.\n\nMore detail here.",
      title: "Alpha",
    });
    const diff = buildDiff([
      diffStat("src/widget.ts", 30, 5),
      diffStat("src/widget.test.ts", 20, 0),
    ]);
    const transcript: TranscriptEvent[] = [
      assistantText({ seq: 1, text: "Working on it." }),
      shellToolCall({ seq: 2, toolCallId: "c1", command: "pnpm test" }),
      toolResult({ seq: 3, toolCallId: "c1", body: "All tests passed." }),
    ];

    const body = buildPrBody({
      session,
      diff,
      transcript,
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    const whyIdx = body.indexOf("## Why");
    const whatIdx = body.indexOf("## What");
    const approachIdx = body.indexOf("## Approach");
    const verificationIdx = body.indexOf("## Verification");
    const sessionIdx = body.indexOf("## Session");

    assert.ok(whyIdx >= 0, "missing Why");
    assert.ok(whatIdx > whyIdx, "What must come after Why");
    assert.ok(approachIdx > whatIdx, "Approach must come after What");
    assert.ok(verificationIdx > approachIdx, "Verification must come after Approach");
    assert.ok(sessionIdx > verificationIdx, "Session must come after Verification");

    assert.match(body, /Implement widget filtering\./);
    assert.match(body, /`src\/widget\.ts` \(\+30 \/ -5\)/);
    assert.match(body, /Tests touched: src\/widget\.test\.ts/);
    assert.match(body, /Last test\/typecheck output:/);
    assert.match(body, /All tests passed\./);
    assert.match(body, /Slug: `alpha` \(branch `minions\/alpha`\)/);
    assert.match(body, /Local UI: http:\/\/localhost:8787\/c\/local\/chat\/alpha/);
  });

  test("no transcript still emits Why, What, Session and omits Approach/Verification", () => {
    const session = buildSession("beta");
    const diff = buildDiff([diffStat("README.md", 1, 1)]);

    const body = buildPrBody({
      session,
      diff,
      transcript: [],
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    assert.match(body, /## Why/);
    assert.match(body, /## What/);
    assert.match(body, /## Session/);
    assert.ok(!body.includes("## Approach"));
    assert.ok(!body.includes("## Verification"));
  });

  test("empty prompt falls back to session.title in Why", () => {
    const session = buildSession("gamma", { prompt: "", title: "Gamma title" });
    const diff = buildDiff([]);

    const body = buildPrBody({
      session,
      diff,
      transcript: [],
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    assert.match(body, /## Why\n\nGamma title/);
  });

  test("large diff caps What at 20 entries plus overflow line", () => {
    const stats: DiffStat[] = [];
    for (let i = 0; i < 50; i++) {
      stats.push(diffStat(`src/file-${i}.ts`, i + 1, 0));
    }
    const diff = buildDiff(stats);

    const body = buildPrBody({
      session: buildSession("delta"),
      diff,
      transcript: [],
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    const afterWhat = body.split("## What\n\n")[1] ?? "";
    const whatBlock = afterWhat.split("\n\n")[0] ?? "";
    const lines = whatBlock.split("\n");
    assert.equal(lines.length, 21, "20 file lines + 1 overflow line");
    assert.equal(lines[20], "- …and 30 more files");
    assert.match(lines[0] ?? "", /file-49\.ts/, "highest churn file should sort first");
  });

  test("no test files in diff omits Tests-touched bullet but keeps Last-output bullet", () => {
    const session = buildSession("eps");
    const diff = buildDiff([diffStat("src/widget.ts", 4, 1)]);
    const transcript: TranscriptEvent[] = [
      shellToolCall({ seq: 1, toolCallId: "c1", command: "pnpm typecheck" }),
      toolResult({ seq: 2, toolCallId: "c1", body: "ok" }),
    ];

    const body = buildPrBody({
      session,
      diff,
      transcript,
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    assert.ok(body.includes("## Verification"));
    assert.ok(!body.includes("Tests touched:"));
    assert.match(body, /Last test\/typecheck output:/);
  });

  test("parentPr set prefixes the body with a Stacks-on line", () => {
    const session = buildSession("zeta");
    const diff = buildDiff([diffStat("a.ts", 1, 0)]);

    const body = buildPrBody({
      session,
      diff,
      transcript: [],
      parentPr: { number: 42, url: "https://example.com/pr/42", parentTitle: "parent title" },
      webBaseUrl: WEB_BASE_URL,
    });

    const lines = body.split("\n");
    assert.equal(lines[0], "Stacks on: PR #42 (parent title)");
    assert.equal(lines[1], "");
    assert.equal(lines[2], "## Why");
  });

  test("parentPr null body starts with ## Why", () => {
    const session = buildSession("eta");
    const diff = buildDiff([diffStat("a.ts", 1, 0)]);

    const body = buildPrBody({
      session,
      diff,
      transcript: [],
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    assert.ok(body.startsWith("## Why"));
    assert.ok(!body.includes("Stacks on:"));
  });

  test("Approach extracted from ## Approach heading rather than full text", () => {
    const session = buildSession("theta");
    const diff = buildDiff([diffStat("a.ts", 1, 0)]);
    const transcript: TranscriptEvent[] = [
      assistantText({
        seq: 1,
        text: [
          "Some preamble text we should not include.",
          "",
          "## Approach",
          "",
          "Use a queue to throttle requests.",
          "",
          "## Risks",
          "",
          "None really.",
        ].join("\n"),
      }),
    ];

    const body = buildPrBody({
      session,
      diff,
      transcript,
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    assert.match(body, /## Approach\n\nUse a queue to throttle requests\./);
    assert.ok(!body.includes("Some preamble text"));
    assert.ok(!body.includes("None really."));
  });

  test("Approach via tail uses last non-partial assistant_text before final tool_call", () => {
    const session = buildSession("iota");
    const diff = buildDiff([diffStat("a.ts", 1, 0)]);
    const transcript: TranscriptEvent[] = [
      assistantText({ seq: 1, text: "First message." }),
      shellToolCall({ seq: 2, toolCallId: "c1", command: "ls" }),
      toolResult({ seq: 3, toolCallId: "c1", body: "files" }),
      assistantText({ seq: 4, text: "Plan: edit the widget module then re-run tests." }),
      shellToolCall({ seq: 5, toolCallId: "c2", command: "pnpm build" }),
      toolResult({ seq: 6, toolCallId: "c2", body: "built" }),
      assistantText({ seq: 7, text: "Done." }),
    ];

    const body = buildPrBody({
      session,
      diff,
      transcript,
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    assert.match(body, /## Approach\n\nPlan: edit the widget module then re-run tests\./);
    assert.ok(!body.includes("Done."));
  });

  test("Verification fenced block contains tool_result body for matching command", () => {
    const session = buildSession("kappa");
    const diff = buildDiff([diffStat("a.ts", 1, 0)]);
    const transcript: TranscriptEvent[] = [
      shellToolCall({ seq: 1, toolCallId: "c1", command: "pnpm test" }),
      toolResult({ seq: 2, toolCallId: "c1", body: "PASS src/widget.test.ts", status: "ok" }),
    ];

    const body = buildPrBody({
      session,
      diff,
      transcript,
      parentPr: null,
      webBaseUrl: WEB_BASE_URL,
    });

    assert.match(body, /```\nPASS src\/widget\.test\.ts\n```/);
  });

  test("rendered body never contains AI attribution strings", () => {
    const session = buildSession("lambda", {
      prompt: "Add widget filter and verify with tests.",
    });
    const diff = buildDiff([diffStat("a.ts", 1, 0)]);
    const transcript: TranscriptEvent[] = [
      assistantText({ seq: 1, text: "I made some edits." }),
      shellToolCall({ seq: 2, toolCallId: "c1", command: "pnpm test" }),
      toolResult({ seq: 3, toolCallId: "c1", body: "ok", status: "ok" }),
    ];

    const body = buildPrBody({
      session,
      diff,
      transcript,
      parentPr: { number: 1, url: "x", parentTitle: "p" },
      webBaseUrl: WEB_BASE_URL,
    });

    const lower = body.toLowerCase();
    assert.ok(!lower.includes("generated"), "must not include 'Generated'");
    assert.ok(!lower.includes("claude"), "must not include 'Claude'");
    assert.ok(!lower.includes("co-authored-by"), "must not include 'Co-authored-by'");
  });
});
