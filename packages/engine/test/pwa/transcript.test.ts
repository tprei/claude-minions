import { describe, it, expect, beforeEach } from "vitest";
import { transcriptNode, renderReply } from "../../pwa/assets/app-v1.js";

function payload(kind: string, extra: Record<string, unknown> = {}) {
  return { taskId: "t", runId: "r", providerEvent: { kind, ...extra } };
}

describe("transcriptNode", () => {
  it("assistant_text → .msg.assistant with text", () => {
    const node = transcriptNode(payload("assistant_text", { text: "hello" }));
    expect(node.className).toBe("msg assistant");
    expect(node.textContent).toContain("hello");
  });

  it("thinking → .msg.thinking with text", () => {
    const node = transcriptNode(payload("thinking", { text: "pondering" }));
    expect(node.className).toBe("msg thinking");
    expect(node.textContent).toContain("pondering");
  });

  it("tool_call → .msg.tool-call with name and input", () => {
    const node = transcriptNode(payload("tool_call", { id: "c1", name: "bash", input: { cmd: "ls" } }));
    expect(node.className).toBe("msg tool-call");
    expect(node.textContent).toContain("bash");
  });

  it("tool_result → .msg.tool-result with output", () => {
    const node = transcriptNode(payload("tool_result", { id: "c1", output: "ok", isError: false }));
    expect(node.className).toBe("msg tool-result");
    expect(node.textContent).toContain("ok");
  });

  it("tool_result with isError → .msg.tool-result.err", () => {
    const node = transcriptNode(payload("tool_result", { id: "c1", output: "fail", isError: true }));
    expect(node.className).toBe("msg tool-result err");
  });

  it("permission_request → .msg.perm with tool name", () => {
    const node = transcriptNode(payload("permission_request", { id: "p1", tool: "read_file", input: {} }));
    expect(node.className).toBe("msg perm");
    expect(node.textContent).toContain("read_file");
  });

  it("usage → .msg.usage with token counts", () => {
    const node = transcriptNode(payload("usage", { inputTokens: 10, outputTokens: 5 }));
    expect(node.className).toBe("msg usage");
    expect(node.textContent).toContain("10");
    expect(node.textContent).toContain("5");
  });

  it("error → .msg.error with message", () => {
    const node = transcriptNode(payload("error", { recoverable: false, message: "something broke" }));
    expect(node.className).toBe("msg error");
    expect(node.textContent).toContain("something broke");
  });

  it("final → .msg.final with sessionRef", () => {
    const node = transcriptNode(payload("final", { sessionRef: "sess-abc" }));
    expect(node.className).toBe("msg final");
    expect(node.textContent).toContain("sess-abc");
  });
});

describe("renderReply", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows textarea and buttons when a needs-review task exists", () => {
    const container = document.createElement("div");
    const workflow = {
      graph: {
        t1: { id: "t1", executionStatus: "needs-review", title: "Fix bug" },
      },
    };
    renderReply(container, workflow);
    expect(container.querySelector("input")).not.toBeNull();
    expect(container.querySelector(".btn-continue")).not.toBeNull();
    expect(container.querySelector(".btn-fresh")).not.toBeNull();
    expect(container.querySelector(".reply-placeholder")).toBeNull();
  });

  it("shows placeholder when no needs-review task exists", () => {
    const container = document.createElement("div");
    const workflow = {
      graph: {
        t1: { id: "t1", executionStatus: "running", title: "Running task" },
      },
    };
    renderReply(container, workflow);
    expect(container.querySelector(".reply-placeholder")).not.toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("shows placeholder when workflow is null", () => {
    const container = document.createElement("div");
    renderReply(container, null);
    expect(container.querySelector(".reply-placeholder")).not.toBeNull();
  });
});
