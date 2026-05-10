import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  buildSinksFromEnv,
  FileSink,
  HttpSink,
  JsonLineSink,
} from "../../src/observability/sinks.js";
import type { LogRecord } from "../../src/observability/types.js";
import type { Sink } from "../../src/observability/sinks.js";

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    t: new Date().toISOString(),
    lvl: "info",
    msg: "test record",
    ...overrides,
  };
}

class RecordingSink implements Sink {
  records: LogRecord[] = [];
  write(r: LogRecord) { this.records.push(r); }
}

describe("JsonLineSink", () => {
  it("error/warn lines go to stderr; debug/info go to stdout", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const sink = new JsonLineSink();

    sink.write(makeRecord({ lvl: "error" }));
    sink.write(makeRecord({ lvl: "warn" }));
    sink.write(makeRecord({ lvl: "info" }));
    sink.write(makeRecord({ lvl: "debug" }));

    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).toHaveBeenCalledTimes(2);

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("line ends with \\n", () => {
    let captured = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      captured = chunk as string;
      return true;
    });

    const sink = new JsonLineSink();
    sink.write(makeRecord({ lvl: "info" }));

    expect(captured.endsWith("\n")).toBe(true);

    stdoutSpy.mockRestore();
  });

  it("record JSON parses to expected fields", () => {
    let captured = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      captured = chunk as string;
      return true;
    });

    const record = makeRecord({ lvl: "info", msg: "hello world", requestId: "r-99" });
    const sink = new JsonLineSink();
    sink.write(record);

    const parsed = JSON.parse(captured) as LogRecord;
    expect(parsed.lvl).toBe("info");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.requestId).toBe("r-99");
    expect(typeof parsed.t).toBe("string");

    stdoutSpy.mockRestore();
  });
});

describe("FileSink", () => {
  it("writes JSONL to a tmp file and parses correctly after close", async () => {
    const filePath = `${tmpdir()}/${randomUUID()}.jsonl`;
    const sink = new FileSink(filePath);

    const r1 = makeRecord({ msg: "line 1" });
    const r2 = makeRecord({ msg: "line 2" });
    sink.write(r1);
    sink.write(r2);

    await sink.close();

    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const parsed0 = JSON.parse(lines[0]!) as LogRecord;
    const parsed1 = JSON.parse(lines[1]!) as LogRecord;
    expect(parsed0.msg).toBe("line 1");
    expect(parsed1.msg).toBe("line 2");
  });

  it("after close(), file content splits by \\n and parses to N records", async () => {
    const filePath = `${tmpdir()}/${randomUUID()}.jsonl`;
    const sink = new FileSink(filePath);

    for (let i = 0; i < 5; i++) {
      sink.write(makeRecord({ msg: `record-${i}` }));
    }
    await sink.close();

    const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    const records = lines.map((l) => JSON.parse(l) as LogRecord);
    expect(records.map((r) => r.msg)).toEqual(["record-0", "record-1", "record-2", "record-3", "record-4"]);
  });

  it("append mode: 3 records, close, reopen same path, 2 more, close — file has all 5", async () => {
    const filePath = `${tmpdir()}/${randomUUID()}.jsonl`;

    const sink1 = new FileSink(filePath);
    sink1.write(makeRecord({ msg: "a" }));
    sink1.write(makeRecord({ msg: "b" }));
    sink1.write(makeRecord({ msg: "c" }));
    await sink1.close();

    const sink2 = new FileSink(filePath);
    sink2.write(makeRecord({ msg: "d" }));
    sink2.write(makeRecord({ msg: "e" }));
    await sink2.close();

    const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    const msgs = lines.map((l) => (JSON.parse(l) as LogRecord).msg);
    expect(msgs).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("HttpSink", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches by size: batchSize 3, fetchImpl resolves OK, write 3 records → 1 fetch call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sink = new HttpSink({
      url: "https://logs.example.com/ingest",
      batchSize: 3,
      flushMs: 999999,
      fetchImpl: fetchMock,
    });

    const r1 = makeRecord({ msg: "r1" });
    const r2 = makeRecord({ msg: "r2" });
    const r3 = makeRecord({ msg: "r3" });
    sink.write(r1);
    sink.write(r2);
    sink.write(r3);

    await sink.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { records: LogRecord[] };
    expect(body.records).toHaveLength(3);
    expect(body.records[0]!.msg).toBe("r1");
    expect(body.records[1]!.msg).toBe("r2");
    expect(body.records[2]!.msg).toBe("r3");
  });

  it("batches by timer: write 1 record, advance timers 50ms → 1 fetch call", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sink = new HttpSink({
      url: "https://logs.example.com/ingest",
      batchSize: 99,
      flushMs: 50,
      fetchImpl: fetchMock,
    });

    sink.write(makeRecord({ msg: "timer-test" }));
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("overflow: queueCap 5, batchSize 99, write 10 records → first 5 dropped, fallback gets sink-degraded warn", async () => {
    const fallback = new RecordingSink();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sink = new HttpSink({
      url: "https://logs.example.com/ingest",
      batchSize: 99,
      flushMs: 999999,
      queueCap: 5,
      fetchImpl: fetchMock,
      fallback,
    });

    for (let i = 0; i < 10; i++) {
      sink.write(makeRecord({ msg: `record-${i}` }));
    }

    await sink.close();

    const degraded = fallback.records.find((r) => r.kind === "sink-degraded");
    expect(degraded).toBeDefined();
    expect(degraded!.dropped).toBe(5);
  });

  it("HTTP non-2xx: fetchImpl returns {ok: false, status: 500}, fallback gets sink-degraded warn", async () => {
    const fallback = new RecordingSink();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const sink = new HttpSink({
      url: "https://logs.example.com/ingest",
      batchSize: 1,
      flushMs: 999999,
      fetchImpl: fetchMock,
      fallback,
    });

    sink.write(makeRecord());
    await sink.close();

    const degraded = fallback.records.find((r) => r.kind === "sink-degraded");
    expect(degraded).toBeDefined();
    expect(degraded!.status).toBe(500);
  });

  it("HTTP throws: fetchImpl rejects, fallback gets sink-degraded warn with error message", async () => {
    const fallback = new RecordingSink();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network failure"));
    const sink = new HttpSink({
      url: "https://logs.example.com/ingest",
      batchSize: 1,
      flushMs: 999999,
      fetchImpl: fetchMock,
      fallback,
    });

    sink.write(makeRecord());
    await sink.close();

    const degraded = fallback.records.find((r) => r.kind === "sink-degraded");
    expect(degraded).toBeDefined();
    expect(degraded!.error).toBe("network failure");
  });

  it("close() flushes remaining queue then resolves cleanly", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sink = new HttpSink({
      url: "https://logs.example.com/ingest",
      batchSize: 99,
      flushMs: 999999,
      fetchImpl: fetchMock,
    });

    sink.write(makeRecord({ msg: "unflushed" }));

    await expect(sink.close()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("close() strictly drains: two size-triggered flushes both complete before close() resolves", async () => {
    const fetchOrder: number[] = [];
    let resolveFetch1!: () => void;
    let resolveFetch2!: () => void;
    const fetch1Done = new Promise<void>((r) => { resolveFetch1 = r; });
    const fetch2Done = new Promise<void>((r) => { resolveFetch2 = r; });

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise<Response>((resolve) => {
          fetch1Done.then(() => {
            fetchOrder.push(1);
            resolve({ ok: true, status: 200 } as Response);
          });
        });
      }
      return new Promise<Response>((resolve) => {
        fetch2Done.then(() => {
          fetchOrder.push(2);
          resolve({ ok: true, status: 200 } as Response);
        });
      });
    });

    const sink = new HttpSink({
      url: "https://logs.example.com/ingest",
      batchSize: 3,
      flushMs: 999999,
      fetchImpl: fetchMock,
    });

    sink.write(makeRecord({ msg: "b1-r1" }));
    sink.write(makeRecord({ msg: "b1-r2" }));
    sink.write(makeRecord({ msg: "b1-r3" }));

    sink.write(makeRecord({ msg: "b2-r1" }));
    sink.write(makeRecord({ msg: "b2-r2" }));
    sink.write(makeRecord({ msg: "b2-r3" }));

    let closeDone = false;
    const closePromise = sink.close().then(() => { closeDone = true; });

    await new Promise((r) => setImmediate(r));
    expect(closeDone).toBe(false);

    resolveFetch1();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(closeDone).toBe(false);

    resolveFetch2();
    await closePromise;
    expect(closeDone).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchOrder).toEqual([1, 2]);

    const body1 = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { records: LogRecord[] };
    const body2 = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as { records: LogRecord[] };
    expect(body1.records.map((r) => r.msg)).toEqual(["b1-r1", "b1-r2", "b1-r3"]);
    expect(body2.records.map((r) => r.msg)).toEqual(["b2-r1", "b2-r2", "b2-r3"]);
  });
});

describe("buildSinksFromEnv", () => {
  it("with no env vars → returns 1 sink (JsonLineSink only)", () => {
    const sinks = buildSinksFromEnv({});
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toBeInstanceOf(JsonLineSink);
  });

  it("with MWF_LOG_FILE set → 2 sinks (JsonLineSink + FileSink)", () => {
    const filePath = `${tmpdir()}/${randomUUID()}.jsonl`;
    const sinks = buildSinksFromEnv({ MWF_LOG_FILE: filePath });
    expect(sinks).toHaveLength(2);
    expect(sinks[0]).toBeInstanceOf(JsonLineSink);
    expect(sinks[1]).toBeInstanceOf(FileSink);
  });

  it("with MWF_LOG_HTTP_URL set (no file) → 2 sinks (JsonLineSink + HttpSink)", () => {
    const sinks = buildSinksFromEnv({ MWF_LOG_HTTP_URL: "https://logs.example.com" });
    expect(sinks).toHaveLength(2);
    expect(sinks[0]).toBeInstanceOf(JsonLineSink);
    expect(sinks[1]).toBeInstanceOf(HttpSink);
  });

  it("with MWF_LOG_FILE and MWF_LOG_HTTP_URL → 3 sinks", () => {
    const filePath = `${tmpdir()}/${randomUUID()}.jsonl`;
    const sinks = buildSinksFromEnv({
      MWF_LOG_FILE: filePath,
      MWF_LOG_HTTP_URL: "https://logs.example.com",
    });
    expect(sinks).toHaveLength(3);
    expect(sinks[0]).toBeInstanceOf(JsonLineSink);
    expect(sinks[1]).toBeInstanceOf(FileSink);
    expect(sinks[2]).toBeInstanceOf(HttpSink);
  });

  it("env-driven HttpSink picks up token, batchSize, flushMs, queueCap overrides", () => {
    const filePath = `${tmpdir()}/${randomUUID()}.jsonl`;
    const sinks = buildSinksFromEnv({
      MWF_LOG_FILE: filePath,
      MWF_LOG_HTTP_URL: "https://logs.example.com",
      MWF_LOG_HTTP_TOKEN: "secret-token",
      MWF_LOG_HTTP_BATCH_SIZE: "25",
      MWF_LOG_HTTP_FLUSH_MS: "3000",
      MWF_LOG_HTTP_QUEUE_CAP: "500",
    });
    expect(sinks).toHaveLength(3);
    expect(sinks[2]).toBeInstanceOf(HttpSink);
  });
});
