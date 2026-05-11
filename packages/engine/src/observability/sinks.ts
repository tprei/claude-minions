import { createWriteStream, type WriteStream } from "node:fs";
import type { LogRecord } from "./types.js";

export interface Sink {
  write(record: LogRecord): void;
  close?(): Promise<void>;
}

export class JsonLineSink implements Sink {
  write(record: LogRecord): void {
    const line = JSON.stringify(record) + "\n";
    const target = record.lvl === "error" || record.lvl === "warn"
      ? process.stderr
      : process.stdout;
    target.write(line);
  }
}

export class FileSink implements Sink {
  private readonly stream: WriteStream;
  private closed = false;
  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { flags: "a" });
  }
  write(record: LogRecord): void {
    if (this.closed) return;
    this.stream.write(JSON.stringify(record) + "\n");
  }
  async close(): Promise<void> {
    this.closed = true;
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
  }
}

export interface HttpSinkOptions {
  url: string;
  token?: string;
  batchSize?: number;
  flushMs?: number;
  queueCap?: number;
  fetchImpl?: typeof fetch;
  fallback?: Sink;
}

export class HttpSink implements Sink {
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly queueCap: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: Sink | undefined;
  private readonly queue: LogRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushPromise: Promise<void> = Promise.resolve();
  private closed = false;
  private droppedSinceLastWarn = 0;

  constructor(opts: HttpSinkOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.batchSize = opts.batchSize ?? 50;
    this.flushMs = opts.flushMs ?? 2000;
    this.queueCap = opts.queueCap ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.fallback = opts.fallback;
  }

  write(record: LogRecord): void {
    if (this.closed) return;
    if (this.queue.length >= this.queueCap) {
      this.queue.shift();
      this.droppedSinceLastWarn++;
    }
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => { void this.flush(); }, this.flushMs);
    }
  }

  private flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.queue.length === 0) return Promise.resolve();
    const batch = this.queue.splice(0, this.queue.length);
    if (this.droppedSinceLastWarn > 0 && this.fallback) {
      const dropped = this.droppedSinceLastWarn;
      this.droppedSinceLastWarn = 0;
      this.fallback.write({
        t: new Date().toISOString(), lvl: "warn",
        msg: "log queue overflow",
        kind: "sink-degraded", sink: "http", dropped,
      });
    }
    const prior = this.flushPromise;
    this.flushPromise = (async () => {
      await prior;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
        const res = await this.fetchImpl(this.url, {
          method: "POST", headers,
          body: JSON.stringify({ records: batch }),
        });
        if (!res.ok && this.fallback) {
          this.fallback.write({
            t: new Date().toISOString(), lvl: "warn",
            msg: "log http sink failed",
            kind: "sink-degraded", sink: "http",
            status: res.status, droppedRecords: batch.length,
          });
        }
      } catch (err) {
        if (this.fallback) {
          this.fallback.write({
            t: new Date().toISOString(), lvl: "warn",
            msg: "log http sink threw",
            kind: "sink-degraded", sink: "http",
            error: (err as Error).message, droppedRecords: batch.length,
          });
        }
      }
    })();
    return this.flushPromise;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.flush();
    await this.flushPromise;
  }
}

export function buildSinksFromEnv(env: NodeJS.ProcessEnv = process.env): Sink[] {
  const sinks: Sink[] = [new JsonLineSink()];
  const filePath = env["MWF_LOG_FILE"];
  if (filePath) sinks.push(new FileSink(filePath));
  const httpUrl = env["MWF_LOG_HTTP_URL"];
  if (httpUrl) {
    const opts: HttpSinkOptions = { url: httpUrl, fallback: sinks[0] as Sink };
    const tok = env["MWF_LOG_HTTP_TOKEN"];
    if (tok) opts.token = tok;
    const bs = env["MWF_LOG_HTTP_BATCH_SIZE"];
    if (bs) opts.batchSize = Math.max(1, parseInt(bs, 10));
    const fm = env["MWF_LOG_HTTP_FLUSH_MS"];
    if (fm) opts.flushMs = Math.max(1, parseInt(fm, 10));
    const cap = env["MWF_LOG_HTTP_QUEUE_CAP"];
    if (cap) opts.queueCap = Math.max(1, parseInt(cap, 10));
    sinks.push(new HttpSink(opts));
  }
  return sinks;
}
