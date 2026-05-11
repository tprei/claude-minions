import { createLogger, type Logger } from "../src/observability/logger.js";
export function silentLogger(bindings: Record<string, unknown> = {}): Logger {
  return createLogger("error", [], bindings);
}
