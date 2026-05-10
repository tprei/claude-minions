import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { LOG_READ_CHUNK_SIZE } from "./constants.js";

export interface LogChunk {
  offset: number;
  bytes: Uint8Array;
}

export async function* followLog(
  path: string,
  fromOffset: number,
  signal: AbortSignal,
): AsyncIterable<LogChunk> {
  if (signal.aborted) return;

  // Check file existence before opening
  try {
    await fsp.access(path);
  } catch {
    return;
  }

  const handle = await fsp.open(path, "r");
  let offset = fromOffset;

  // Register the watcher BEFORE the initial drain so any append landing between
  // replay and live-loop registration is captured by the appendPromise.
  let resolveAppend: (() => void) | undefined;
  let appendPromise: Promise<void> = new Promise((r) => { resolveAppend = r; });

  let generation = 0;

  const onWatch = () => {
    generation += 1;
    const prev = resolveAppend;
    appendPromise = new Promise((r) => { resolveAppend = r; });
    prev?.();
  };

  fs.watchFile(path, { interval: 100 }, onWatch);

  const onAbort = () => { resolveAppend?.(); };
  signal.addEventListener("abort", onAbort);

  try {
    // Drain-then-await loop covers replay, race-window appends, and live tail uniformly.
    while (!signal.aborted) {
      const seen = generation;

      const stat = await handle.stat();
      const size = stat.size;

      // treat truncation as rotation; restart from new file head
      if (size < offset) offset = 0;

      while (offset < size && !signal.aborted) {
        const toRead = Math.min(LOG_READ_CHUNK_SIZE, size - offset);
        const buf = Buffer.allocUnsafe(toRead);
        const { bytesRead } = await handle.read(buf, 0, toRead, offset);
        if (bytesRead === 0) break;
        yield { offset, bytes: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead) };
        offset += bytesRead;
      }

      if (signal.aborted) break;
      // If onWatch fired during the drain above, generation advanced past seen.
      // Re-loop immediately so we stat again and pick up the new bytes rather
      // than suspending on the already-resolved appendPromise.
      if (seen !== generation) continue;
      await appendPromise;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    fs.unwatchFile(path, onWatch);
    await handle.close();
  }
}
