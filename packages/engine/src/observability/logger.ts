import type { Level, LogRecord } from "./types.js";
import type { Sink } from "./sinks.js";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  level: Level;
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  level: Level,
  sinks: Sink[],
  bindings: Record<string, unknown> = {},
): Logger {
  const log = (lvl: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (order[lvl] < order[level]) return;
    const record: LogRecord = {
      t: new Date().toISOString(),
      lvl,
      msg,
      ...bindings,
      ...fields,
    };
    for (const sink of sinks) {
      try { sink.write(record); } catch { /* sink failures must never crash callers */ }
    }
  };
  return {
    get level() { return level; },
    child(extra) { return createLogger(level, sinks, { ...bindings, ...extra }); },
    debug: (m, f) => log("debug", m, f),
    info:  (m, f) => log("info",  m, f),
    warn:  (m, f) => log("warn",  m, f),
    error: (m, f) => log("error", m, f),
  };
}

export function parseLevel(raw: string | undefined): Level {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}
