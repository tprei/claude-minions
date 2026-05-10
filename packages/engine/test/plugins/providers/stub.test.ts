import { describe, expect, it } from "vitest";
import { StubProviderPlugin } from "../../../src/plugins/providers/stub.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";

describe("StubProviderPlugin", () => {
  it("round-trip canned frames: counter advances and returns correct frame groups", () => {
    const group1: ProviderEvent[] = [{ kind: "assistant_text", text: "Hello" }];
    const group2: ProviderEvent[] = [
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "final", sessionRef: "stub-session" },
    ];
    const stub = new StubProviderPlugin({ frames: [group1, group2] });

    expect(stub.parseFrame("line-1")).toEqual(group1);
    expect(stub.parseFrame("line-2")).toEqual(group2);
    expect(stub.parseFrame("line-3")).toEqual([]);
  });

  it("capability vector has correct literal shape", () => {
    const stub = new StubProviderPlugin({ frames: [] });
    expect(stub.capabilities).toEqual({
      resume: true,
      mcp: false,
      structuredOutput: false,
      oauthLogin: false,
      streamJson: true,
      sessionRefFormat: "opaque",
    });
  });

  it("prepare returns echo stub invocation", async () => {
    const stub = new StubProviderPlugin({ frames: [] });
    const inv = await stub.prepare({
      taskId: "t1",
      workflowId: "wf1",
      prompt: "do something",
      dependencyArtifacts: [],
    });
    expect(inv.command).toEqual(["echo", "stub"]);
    expect(inv.providerType).toBe("stub");
  });

  it("resume returns echo stub invocation", async () => {
    const stub = new StubProviderPlugin({ frames: [] });
    const inv = await stub.resume({ taskId: "t1", workflowId: "wf1", sessionRef: "sess-1", prompt: "continue" });
    expect(inv.command).toEqual(["echo", "stub"]);
    expect(inv.providerType).toBe("stub");
  });

  it("prepare throws when prompt is empty", async () => {
    const stub = new StubProviderPlugin({ frames: [] });
    await expect(
      stub.prepare({ taskId: "t1", workflowId: "wf1", prompt: "", dependencyArtifacts: [] }),
    ).rejects.toThrow("prompt must be non-empty");
  });

  it("resume throws when prompt is empty", async () => {
    const stub = new StubProviderPlugin({ frames: [] });
    await expect(
      stub.resume({ taskId: "t1", workflowId: "wf1", sessionRef: "sess-1", prompt: "" }),
    ).rejects.toThrow("prompt must be non-empty");
  });

  it("loginStatus returns loggedIn true", async () => {
    const stub = new StubProviderPlugin({ frames: [] });
    expect(await stub.loginStatus()).toEqual({ loggedIn: true });
  });

  it("name is stub", () => {
    const stub = new StubProviderPlugin({ frames: [] });
    expect(stub.name).toBe("stub");
  });
});
