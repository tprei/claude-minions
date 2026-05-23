import type { RuntimeAttachOptions, RuntimeBackend } from "../runtime-backend.js";
import type { ProviderEvent, ProviderPlugin } from "../provider-plugin.js";
import { LineBuffer } from "../line-buffer.js";

export type RunProviderItem =
  | { kind: "provider"; event: ProviderEvent }
  | { kind: "offset"; offset: number };

export interface RunProviderOptions {
  signal?: AbortSignal;
  fromOffset?: number;
}

// Offset is the upper bound of bytes received so far for the chunk.
// Yielding it before events means latestOffset is always >= the byte position
// of any event in the same chunk, so resume re-attaches from a safe position.
export async function* runProvider(
  runtime: RuntimeBackend,
  sessionId: string,
  provider: ProviderPlugin,
  opts: RunProviderOptions = {},
): AsyncIterable<RunProviderItem> {
  const buffer = new LineBuffer();
  const attachOpts: RuntimeAttachOptions = { fromOffset: opts.fromOffset ?? 0 };
  if (opts.signal !== undefined) attachOpts.signal = opts.signal;

  for await (const chunk of runtime.attach(sessionId, attachOpts)) {
    const offset = chunk.offset + chunk.bytes.byteLength;
    yield { kind: "offset", offset };
    const lines = buffer.push(chunk.bytes);
    for (const line of lines) {
      let events: ProviderEvent[];
      try {
        events = provider.parseFrame(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { kind: "provider", event: { kind: "error", recoverable: true, message, source: "parseFrame" } };
        continue;
      }
      for (const event of events) {
        yield { kind: "provider", event };
      }
    }
  }

  const tail = buffer.flush();
  for (const line of tail) {
    let events: ProviderEvent[];
    try {
      events = provider.parseFrame(line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { kind: "provider", event: { kind: "error", recoverable: true, message, source: "parseFrame" } };
      continue;
    }
    for (const event of events) {
      yield { kind: "provider", event };
    }
  }
}
