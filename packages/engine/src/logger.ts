type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  level: Level;
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(level: Level, msg: string, bindings: Record<string, unknown>, fields?: Record<string, unknown>) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    lvl: level,
    msg,
    ...bindings,
    ...fields,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export function createLogger(level: Level = "info", bindings: Record<string, unknown> = {}): Logger {
  const log = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    emit(lvl, msg, bindings, fields);
  };
  return {
    get level() {
      return level;
    },
    child(extra: Record<string, unknown>): Logger {
      return createLogger(level, { ...bindings, ...extra });
    },
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
  };
}
