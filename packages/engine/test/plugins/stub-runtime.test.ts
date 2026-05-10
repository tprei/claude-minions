import { describe, expect, it } from "vitest";
import { StubRuntimeBackend } from "../../src/plugins/stub-runtime.js";

describe("StubRuntimeBackend", () => {
  it("start returns incrementing stub session ids and runtimeType stub", async () => {
    const backend = new StubRuntimeBackend();

    const r1 = await backend.start({ taskId: "t1", workflowId: "wf-1", command: ["echo"] });
    const r2 = await backend.start({ taskId: "t2", workflowId: "wf-1", command: ["echo"] });

    expect(r1.sessionId).toBe("stub-1");
    expect(r1.runtimeType).toBe("stub");
    expect(r2.sessionId).toBe("stub-2");
    expect(r2.runtimeType).toBe("stub");
  });

  it("probe returns live for started session, missing for unknown, missing after stop", async () => {
    const backend = new StubRuntimeBackend();
    const { sessionId } = await backend.start({ taskId: "t1", workflowId: "wf-1", command: [] });

    expect(await backend.probe(sessionId)).toBe("live");
    expect(await backend.probe("unknown-session")).toBe("missing");

    await backend.stop(sessionId);
    expect(await backend.probe(sessionId)).toBe("missing");
  });

  it("attach returns an empty async iterable", async () => {
    const backend = new StubRuntimeBackend();
    const { sessionId } = await backend.start({ taskId: "t1", workflowId: "wf-1", command: [] });

    const chunks: import("../../src/plugins/runtime-backend.js").RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach(sessionId)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it("attach with opts yields nothing", async () => {
    const backend = new StubRuntimeBackend();
    const { sessionId } = await backend.start({ taskId: "t1", workflowId: "wf-1", command: [] });

    const chunks: import("../../src/plugins/runtime-backend.js").RuntimeOutputChunk[] = [];
    for await (const chunk of backend.attach(sessionId, { fromOffset: 100 })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
