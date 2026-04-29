import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeProvider } from "./claudeCode.js";
import type { ParseStreamState, ProviderEvent } from "./provider.js";

function feed(lines: unknown[]): ProviderEvent[] {
  let state: ParseStreamState = { buffer: "", turn: 0 };
  const all: ProviderEvent[] = [];
  for (const obj of lines) {
    const chunk = JSON.stringify(obj) + "\n";
    const { events, state: next } = claudeCodeProvider.parseStreamChunk(chunk, state);
    all.push(...events);
    state = next;
  }
  return all;
}

describe("claudeCode parseStreamChunk — turn boundaries", () => {
  it("emits exactly one turn_started across an agentic loop with multiple tool_uses", () => {
    const stream = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "thinking..." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file1\nfile2" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t2", content: "/tmp" }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t3", name: "Bash", input: { command: "whoami" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t3", content: "root" }],
        },
      },
      { type: "result", subtype: "success", stop_reason: "end_turn" },
    ];

    const events = feed(stream);

    const turnStarted = events.filter((e) => e.kind === "turn_started");
    assert.equal(
      turnStarted.length,
      1,
      `expected exactly one turn_started across an agentic loop; got ${turnStarted.length}`,
    );

    const turnCompleted = events.filter((e) => e.kind === "turn_completed");
    assert.equal(turnCompleted.length, 1, "expected one turn_completed at the result boundary");

    const toolCalls = events.filter((e) => e.kind === "tool_call");
    assert.equal(toolCalls.length, 3, "all tool_use blocks must surface as tool_call events");
  });

  it("emits a fresh turn_started after a result boundary on the next assistant record", () => {
    const stream = [
      { type: "system", subtype: "init", session_id: "sess-2" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      },
      { type: "result", subtype: "success", stop_reason: "end_turn" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      },
      { type: "result", subtype: "success", stop_reason: "end_turn" },
    ];

    const events = feed(stream);
    const turnStarted = events.filter((e) => e.kind === "turn_started");
    assert.equal(turnStarted.length, 2, "each result→assistant transition must start a new turn");
  });
});
