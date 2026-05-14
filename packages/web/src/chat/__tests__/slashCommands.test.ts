import { describe, it, expect } from "vitest";
import { slashCommands, type SlashContext } from "../slashCommands.js";

const ctx: SlashContext = { workflowId: "wf-1", taskId: "task-1" };
const argsByName: Record<string, string[]> = {
  reply: ["follow", "up"],
  retry: ["start", "fresh"],
};

describe("slashCommands", () => {
  it("only registers current engine commands and implemented UI actions", () => {
    const acceptedCommandKinds = new Set([
      "continue-task",
      "retry-task",
      "transition-task",
      "land-workflow",
    ]);
    const acceptedUiActions = new Set(["help", "cost"]);

    for (const cmd of slashCommands) {
      const result = cmd.build(argsByName[cmd.name] ?? [], ctx);
      if (result.kind === "command") {
        expect(acceptedCommandKinds.has(result.payload.kind), `/${cmd.name}`).toBe(true);
      } else {
        expect(acceptedUiActions.has(result.action), `/${cmd.name}`).toBe(true);
      }
    }
  });

  it("/reply dispatches continue-task for the active task", () => {
    const cmd = slashCommands.find((c) => c.name === "reply");
    expect(cmd?.build(["ship", "it"], ctx)).toEqual({
      kind: "command",
      payload: {
        kind: "continue-task",
        workflowId: "wf-1",
        taskId: "task-1",
        prompt: "ship it",
      },
    });
  });

  it("/cancel dispatches the current transition-task shape", () => {
    const cmd = slashCommands.find((c) => c.name === "cancel");
    const result = cmd?.build([], ctx);
    expect(result).toEqual({
      kind: "command",
      payload: {
        kind: "transition-task",
        workflowId: "wf-1",
        transition: {
          kind: "cancel",
          taskId: "task-1",
          now: expect.any(String),
        },
      },
    });
  });

  it("drops pre-port session and loop commands", () => {
    const names = new Set(slashCommands.map((c) => c.name));
    for (const stale of ["judge", "loops", "execute-plan", "force", "stack", "split"]) {
      expect(names.has(stale), stale).toBe(false);
    }
  });
});
