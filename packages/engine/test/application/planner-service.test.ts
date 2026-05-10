import { describe, expect, it } from "vitest";
import { WorkflowPlannerService } from "../../src/application/planner-service.js";
import { DomainError } from "../../src/domain/errors.js";
import { silentLogger } from "../test-helpers.js";
import type Anthropic from "@anthropic-ai/sdk";

const NOW = "2026-05-10T00:00:00.000Z";
const now = () => NOW;

function makeMessage(text: string): Anthropic.Message {
  return {
    id: "msg-test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text, citations: [] }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

function makePlanner(
  messagesCreate: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>,
) {
  return new WorkflowPlannerService({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    log: silentLogger(),
    now,
    messagesCreate,
  });
}

describe("WorkflowPlannerService", () => {
  it("parses a valid single-task response", async () => {
    const raw = JSON.stringify({
      kind: "single-task",
      tasks: [{ id: "t0", title: "Do the thing", prompt: "Do the thing in detail", dependsOn: [] }],
    });

    const planner = makePlanner(async () => makeMessage(raw));
    const spec = await planner.plan({ prompt: "Do the thing" });

    expect(spec.kind).toBe("single-task");
    expect(spec.tasks).toHaveLength(1);
    expect(spec.tasks[0]?.title).toBe("Do the thing");
    expect(spec.tasks[0]?.prompt).toBe("Do the thing in detail");
    expect(spec.tasks[0]?.dependsOn).toEqual([]);
    // ids are regenerated on engine side
    expect(typeof spec.id).toBe("string");
    expect(typeof spec.tasks[0]?.id).toBe("string");
  });

  it("parses a valid multi-task manual-dag response with dependsOn", async () => {
    const raw = JSON.stringify({
      kind: "manual-dag",
      tasks: [
        { id: "t0", title: "Setup", prompt: "Set up environment", dependsOn: [] },
        { id: "t1", title: "Build", prompt: "Build the thing", dependsOn: ["t0"] },
        { id: "t2", title: "Test", prompt: "Run tests", dependsOn: ["t0"] },
      ],
    });

    const planner = makePlanner(async () => makeMessage(raw));
    const spec = await planner.plan({ prompt: "Setup, build, and test the project" });

    expect(spec.kind).toBe("manual-dag");
    expect(spec.tasks).toHaveLength(3);

    const taskMap = new Map(spec.tasks.map((t) => [t.title, t]));
    const setup = taskMap.get("Setup");
    const build = taskMap.get("Build");
    const test = taskMap.get("Test");

    expect(setup?.dependsOn).toEqual([]);
    // Build depends on Setup (remapped ids)
    expect(build?.dependsOn).toHaveLength(1);
    expect(build?.dependsOn?.[0]).toBe(setup?.id);
    // Test depends on Setup (remapped ids)
    expect(test?.dependsOn).toHaveLength(1);
    expect(test?.dependsOn?.[0]).toBe(setup?.id);
  });

  it("rejects malformed JSON", async () => {
    const planner = makePlanner(async () => makeMessage("not json at all {{{{"));
    await expect(planner.plan({ prompt: "do something" })).rejects.toThrow(DomainError);
    await expect(planner.plan({ prompt: "do something" })).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("rejects a plan with zero tasks", async () => {
    const raw = JSON.stringify({ kind: "single-task", tasks: [] });
    const planner = makePlanner(async () => makeMessage(raw));
    await expect(planner.plan({ prompt: "do something" })).rejects.toThrow(DomainError);
    await expect(planner.plan({ prompt: "do something" })).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("rejects a plan with unknown dependsOn reference", async () => {
    const raw = JSON.stringify({
      kind: "manual-dag",
      tasks: [
        { id: "t0", title: "A", prompt: "do A", dependsOn: ["nonexistent"] },
      ],
    });
    const planner = makePlanner(async () => makeMessage(raw));
    await expect(planner.plan({ prompt: "do A" })).rejects.toThrow(DomainError);
    await expect(planner.plan({ prompt: "do A" })).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("rejects a plan with a cycle", async () => {
    const raw = JSON.stringify({
      kind: "manual-dag",
      tasks: [
        { id: "t0", title: "A", prompt: "do A", dependsOn: ["t1"] },
        { id: "t1", title: "B", prompt: "do B", dependsOn: ["t0"] },
      ],
    });
    const planner = makePlanner(async () => makeMessage(raw));
    await expect(planner.plan({ prompt: "A and B depend on each other" })).rejects.toThrow(DomainError);
    await expect(planner.plan({ prompt: "A and B depend on each other" })).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("rejects an invalid kind", async () => {
    const raw = JSON.stringify({ kind: "unknown-kind", tasks: [{ id: "t0", title: "A", prompt: "do A", dependsOn: [] }] });
    const planner = makePlanner(async () => makeMessage(raw));
    await expect(planner.plan({ prompt: "do A" })).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("remaps llm task ids to unique engine-generated ids", async () => {
    const raw = JSON.stringify({
      kind: "manual-dag",
      tasks: [
        { id: "t0", title: "First", prompt: "first task", dependsOn: [] },
        { id: "t1", title: "Second", prompt: "second task", dependsOn: ["t0"] },
      ],
    });

    const planner = makePlanner(async () => makeMessage(raw));
    const spec = await planner.plan({ prompt: "do two tasks" });

    // LLM ids must not appear in the output
    const ids = spec.tasks.map((t) => t.id);
    expect(ids).not.toContain("t0");
    expect(ids).not.toContain("t1");

    // All ids must be unique
    expect(new Set(ids).size).toBe(ids.length);

    // Dependency references must point to valid engine-generated ids
    const second = spec.tasks.find((t) => t.title === "Second");
    const first = spec.tasks.find((t) => t.title === "First");
    expect(second?.dependsOn).toEqual([first?.id]);
  });
});
