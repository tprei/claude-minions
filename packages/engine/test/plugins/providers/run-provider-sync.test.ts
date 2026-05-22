import { describe, expect, it } from "vitest";
import { runProviderToCompletion } from "../../../src/plugins/providers/run-provider-sync.js";
import { StubProviderPlugin } from "../../../src/plugins/providers/stub.js";
import type { ProviderEvent } from "../../../src/plugins/provider-plugin.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk } from "../../../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../../../src/application/recovery.js";

function makeRuntime(chunks: RuntimeOutputChunk[]): RuntimeBackend {
  return {
    start: () => Promise.reject(new Error("not used")),
    stop: () => Promise.reject(new Error("not used")),
    probe: () => Promise.resolve("live" as RuntimeProbeState),
    attach(_sessionId: string, _opts?: RuntimeAttachOptions): AsyncIterable<RuntimeOutputChunk> {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      };
    },
  };
}

function chunk(offset: number, text: string): RuntimeOutputChunk {
  return { sessionId: "s1", offset, bytes: new TextEncoder().encode(text) };
}

describe("runProviderToCompletion", () => {
  it("final received → finalReceived true, sessionRef captured", async () => {
    const provider = new StubProviderPlugin({ frames: [[{ kind: "final", sessionRef: "sess-9" } satisfies ProviderEvent]] });
    const summary = await runProviderToCompletion(makeRuntime([chunk(0, "l\n")]), "s1", provider, {});
    expect(summary.finalReceived).toBe(true);
    expect(summary.sessionRef).toBe("sess-9");
    expect(summary.fatalError).toBeUndefined();
  });

  it("non-recoverable error then final → fatalError set, finalReceived true", async () => {
    const provider = new StubProviderPlugin({
      frames: [
        [{ kind: "error", recoverable: false, message: "boom", source: "x" } satisfies ProviderEvent],
        [{ kind: "final", sessionRef: "s" } satisfies ProviderEvent],
      ],
    });
    const summary = await runProviderToCompletion(makeRuntime([chunk(0, "a\n"), chunk(2, "b\n")]), "s1", provider, {});
    expect(summary.fatalError).toEqual({ message: "boom", source: "x" });
    expect(summary.finalReceived).toBe(true);
  });

  it("stream ends without final → finalReceived false", async () => {
    const provider = new StubProviderPlugin({ frames: [[{ kind: "assistant_text", text: "hi" } satisfies ProviderEvent]] });
    const summary = await runProviderToCompletion(makeRuntime([chunk(0, "a\n")]), "s1", provider, {});
    expect(summary.finalReceived).toBe(false);
    expect(summary.sessionRef).toBeUndefined();
  });
});
