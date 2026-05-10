import { describe, expect, it } from "vitest";
import { createLogger, parseLevel } from "../../src/observability/logger.js";
import type { Sink } from "../../src/observability/sinks.js";
import type { LogRecord } from "../../src/observability/types.js";

class RecordingSink implements Sink {
  records: LogRecord[] = [];
  write(r: LogRecord) { this.records.push(r); }
}

describe("Logger", () => {
  it("level filter: info-level logger drops debug calls but emits info/warn/error", () => {
    const sink = new RecordingSink();
    const log = createLogger("info", [sink]);

    log.debug("should be dropped");
    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");

    expect(sink.records).toHaveLength(3);
    expect(sink.records[0]?.lvl).toBe("info");
    expect(sink.records[1]?.lvl).toBe("warn");
    expect(sink.records[2]?.lvl).toBe("error");
  });

  it("child(bindings) merges into output", () => {
    const sink = new RecordingSink();
    const log = createLogger("debug", [sink]);
    const child = log.child({ service: "auth" });

    child.info("hello");

    expect(sink.records[0]).toMatchObject({ service: "auth", msg: "hello" });
  });

  it("nested children stack bindings 3 levels deep", () => {
    const sink = new RecordingSink();
    const log = createLogger("debug", [sink]);
    const l1 = log.child({ a: 1 });
    const l2 = l1.child({ b: 2 });
    const l3 = l2.child({ c: 3 });

    l3.info("deep");

    expect(sink.records[0]).toMatchObject({ a: 1, b: 2, c: 3, msg: "deep" });
  });

  it("per-call fields override bindings on key collision", () => {
    const sink = new RecordingSink();
    const log = createLogger("debug", [sink]);
    const child = log.child({ requestId: "binding-value" });

    child.info("override test", { requestId: "call-value" });

    expect(sink.records[0]?.requestId).toBe("call-value");
  });

  it("a throwing sink does not crash the logger or other sinks", () => {
    const throwingSink: Sink = {
      write() { throw new Error("sink exploded"); },
    };
    const recording = new RecordingSink();
    const log = createLogger("debug", [throwingSink, recording]);

    expect(() => log.info("test message")).not.toThrow();
    expect(recording.records).toHaveLength(1);
    expect(recording.records[0]?.msg).toBe("test message");
  });

  it("multiple sinks all receive the same record", () => {
    const sink1 = new RecordingSink();
    const sink2 = new RecordingSink();
    const log = createLogger("debug", [sink1, sink2]);

    log.info("broadcast");

    expect(sink1.records).toHaveLength(1);
    expect(sink2.records).toHaveLength(1);
    expect(sink1.records[0]).toBe(sink2.records[0]);
  });

  it("LogRecord has mandatory fields: t, lvl, msg, plus bindings and fields", () => {
    const sink = new RecordingSink();
    const log = createLogger("debug", [sink]);
    const child = log.child({ service: "gateway" });

    child.warn("check fields", { requestId: "r-1" });

    const record = sink.records[0];
    expect(record).toBeDefined();
    expect(typeof record!.t).toBe("string");
    expect(() => new Date(record!.t)).not.toThrow();
    expect(record!.lvl).toBe("warn");
    expect(record!.msg).toBe("check fields");
    expect(record!.service).toBe("gateway");
    expect(record!.requestId).toBe("r-1");
  });

  it("parseLevel returns the input for valid levels and 'info' for invalid", () => {
    expect(parseLevel("debug")).toBe("debug");
    expect(parseLevel("info")).toBe("info");
    expect(parseLevel("warn")).toBe("warn");
    expect(parseLevel("error")).toBe("error");
    expect(parseLevel("verbose")).toBe("info");
    expect(parseLevel("")).toBe("info");
    expect(parseLevel(undefined)).toBe("info");
  });
});
