import { describe, expect, it } from "vitest";
import { runProvider } from "../../src/plugins/providers/run-provider.js";
import type { RunProviderItem } from "../../src/plugins/providers/run-provider.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk } from "../../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../../src/application/recovery.js";

function makeRuntime(chunks: RuntimeOutputChunk[]): RuntimeBackend {
  return {
    start: () => Promise.reject(new Error("not used")),
    stop: () => Promise.reject(new Error("not used")),
    probe: () => Promise.resolve("live" as RuntimeProbeState),
    attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      };
    },
  };
}

function encodeChunk(sessionId: string, offset: number, text: string): RuntimeOutputChunk {
  const bytes = new TextEncoder().encode(text);
  return { sessionId, offset, bytes };
}

describe("runProvider", () => {
  it("yields provider items and offset items interleaved", async () => {
    const assistantEvent: ProviderEvent = { kind: "assistant_text", text: "hello" };
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "sess-1" };

    const provider = new StubProviderPlugin({ frames: [[assistantEvent], [finalEvent]] });

    const chunks = [
      encodeChunk("s1", 0, "line-1\n"),
      encodeChunk("s1", 7, "line-2\n"),
    ];
    const runtime = makeRuntime(chunks);

    const items: RunProviderItem[] = [];
    for await (const item of runProvider(runtime, "s1", provider, {})) {
      items.push(item);
    }

    const providerItems = items.filter((i): i is Extract<RunProviderItem, { kind: "provider" }> => i.kind === "provider");
    const offsetItems = items.filter((i): i is Extract<RunProviderItem, { kind: "offset" }> => i.kind === "offset");

    expect(providerItems).toHaveLength(2);
    expect(providerItems[0]?.event).toEqual(assistantEvent);
    expect(providerItems[1]?.event).toEqual(finalEvent);

    expect(offsetItems).toHaveLength(2);
    expect(offsetItems[0]?.offset).toBe(7);
    expect(offsetItems[1]?.offset).toBe(14);
  });

  it("offset item appears before provider items from the same chunk", async () => {
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "s" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    const chunks = [encodeChunk("s1", 0, "line-1\n")];
    const runtime = makeRuntime(chunks);

    const items: RunProviderItem[] = [];
    for await (const item of runProvider(runtime, "s1", provider)) {
      items.push(item);
    }

    expect(items[0]?.kind).toBe("offset");
    expect(items[1]?.kind).toBe("provider");
  });

  it("no chunks → no items emitted", async () => {
    const provider = new StubProviderPlugin({ frames: [] });
    const runtime = makeRuntime([]);

    const items: RunProviderItem[] = [];
    for await (const item of runProvider(runtime, "s1", provider)) {
      items.push(item);
    }

    expect(items).toHaveLength(0);
  });

  it("tail lines after attach loop are emitted as provider items without offset", async () => {
    const finalEvent: ProviderEvent = { kind: "final", sessionRef: "s" };
    const provider = new StubProviderPlugin({ frames: [[finalEvent]] });

    const bytes = new TextEncoder().encode("no-newline");
    const chunks = [{ sessionId: "s1", offset: 0, bytes }];
    const runtime = makeRuntime(chunks);

    const items: RunProviderItem[] = [];
    for await (const item of runProvider(runtime, "s1", provider)) {
      items.push(item);
    }

    const providerItems = items.filter((i) => i.kind === "provider");
    expect(providerItems).toHaveLength(1);
  });

  it("passes fromOffset to runtime.attach", async () => {
    let capturedOpts: RuntimeAttachOptions | undefined;
    const runtime: RuntimeBackend = {
      start: () => Promise.reject(new Error("not used")),
      stop: () => Promise.reject(new Error("not used")),
      probe: () => Promise.resolve("live" as RuntimeProbeState),
      attach(_sessionId: string, opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
        capturedOpts = opts;
        return { [Symbol.asyncIterator]: async function* () {} };
      },
    };

    const provider = new StubProviderPlugin({ frames: [] });
    for await (const _ of runProvider(runtime, "s1", provider, { fromOffset: 7 })) { /* drain */ }

    expect(capturedOpts?.fromOffset).toBe(7);
  });
});
