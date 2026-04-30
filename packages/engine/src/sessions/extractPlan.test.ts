import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { extractPlanFromThink } from "./extractPlan.js";
import type { EngineContext } from "../context.js";
import type { TranscriptEvent } from "@minions/shared";

function buildCtx(events: TranscriptEvent[]): EngineContext {
  return {
    sessions: {
      transcript: (_slug: string, _sinceSeq?: number): TranscriptEvent[] => events,
    },
  } as unknown as EngineContext;
}

function writeToolCall(seq: number, filePath: string): TranscriptEvent {
  return {
    id: `evt-${seq}`,
    sessionSlug: "s1",
    seq,
    turn: 0,
    timestamp: "2026-01-01T00:00:00Z",
    kind: "tool_call",
    toolCallId: `tc-${seq}`,
    toolName: "Write",
    toolKind: "write",
    summary: "Write(file_path)",
    input: { file_path: filePath },
  };
}

function assistantText(seq: number, text: string): TranscriptEvent {
  return {
    id: `evt-${seq}`,
    sessionSlug: "s1",
    seq,
    turn: 0,
    timestamp: "2026-01-01T00:00:00Z",
    kind: "assistant_text",
    text,
  };
}

const LONG_TEXT = "x".repeat(250);
const SECOND_LONG_TEXT = "y".repeat(220);

describe("extractPlanFromThink", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extract-plan-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("(a) prefers /.claude/plans/ .md write and returns its file contents", async () => {
    const plansDir = path.join(tmpDir, ".claude", "plans");
    await fs.mkdir(plansDir, { recursive: true });
    const planFile = path.join(plansDir, "foo.md");
    const planBody = "# Plan\n\nThis is the real plan.\n";
    await fs.writeFile(planFile, planBody, "utf8");

    const otherMd = path.join(tmpDir, "notes.md");
    await fs.writeFile(otherMd, "# Other notes\n", "utf8");

    const ctx = buildCtx([
      writeToolCall(1, otherMd),
      writeToolCall(2, planFile),
      assistantText(3, LONG_TEXT),
    ]);

    const result = await extractPlanFromThink(ctx, "s1");
    assert.equal(result.source, "file");
    assert.equal(result.plan, planBody);
  });

  test("(b) falls back to non-plans .md write when no /.claude/plans/ matches", async () => {
    const notesPath = path.join(tmpDir, "notes.md");
    const body = "# Notes\n\nfreeform plan content\n";
    await fs.writeFile(notesPath, body, "utf8");

    const ctx = buildCtx([
      writeToolCall(1, notesPath),
      assistantText(2, LONG_TEXT),
    ]);

    const result = await extractPlanFromThink(ctx, "s1");
    assert.equal(result.source, "file");
    assert.equal(result.plan, body);
  });

  test("(c) returns last sufficiently-long assistant_text when no .md writes exist", async () => {
    const ctx = buildCtx([
      assistantText(1, "too short"),
      assistantText(2, LONG_TEXT),
      assistantText(3, SECOND_LONG_TEXT),
    ]);

    const result = await extractPlanFromThink(ctx, "s1");
    assert.equal(result.source, "transcript");
    assert.equal(result.plan, SECOND_LONG_TEXT);
  });

  test("(d) returns empty plan with source 'transcript' for empty transcript", async () => {
    const ctx = buildCtx([]);
    const result = await extractPlanFromThink(ctx, "s1");
    assert.deepEqual(result, { plan: "", source: "transcript" });
  });

  test("(e) falls back to assistant_text when .md write target is missing on disk", async () => {
    const missing = path.join(tmpDir, ".claude", "plans", "ghost.md");
    const ctx = buildCtx([
      writeToolCall(1, missing),
      assistantText(2, LONG_TEXT),
    ]);

    const result = await extractPlanFromThink(ctx, "s1");
    assert.equal(result.source, "transcript");
    assert.equal(result.plan, LONG_TEXT);
  });
});
