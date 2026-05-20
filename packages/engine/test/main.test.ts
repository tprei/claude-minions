import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler, parseRecoveryScanIntervalMs } from "../src/main.js";

describe("parseRecoveryScanIntervalMs", () => {
  it("accepts undefined and non-negative integers", () => {
    expect(parseRecoveryScanIntervalMs(undefined)).toBeUndefined();
    expect(parseRecoveryScanIntervalMs("0")).toBe(0);
    expect(parseRecoveryScanIntervalMs("60000")).toBe(60000);
  });

  it.each(["-1", "1.5", "abc", "9007199254740992"])(
    "rejects invalid value %s",
    (value) => {
      expect(() => parseRecoveryScanIntervalMs(value)).toThrow(
        `invalid MWF_RECOVERY_SCAN_INTERVAL_MS="${value}"; must be a non-negative integer`,
      );
    },
  );
});

describe("createShutdownHandler", () => {
  it("starts server close, waits for engine close, then waits for server drain once", async () => {
    const events: string[] = [];
    let closeCallback: ((err?: Error) => void) | undefined;
    let resolveEngineClose: (() => void) | undefined;
    const httpServer = {
      close: vi.fn((callback: (err?: Error) => void) => {
        events.push("server.close");
        closeCallback = callback;
      }),
    };
    const engine = {
      close: vi.fn(() => new Promise<void>((resolve) => {
        events.push("engine.close");
        resolveEngineClose = resolve;
      })),
    };
    const exit = vi.fn((code: number) => {
      events.push(`exit:${code}`);
    });
    const log = vi.fn((message: string) => {
      events.push(`log:${message}`);
    });

    const shutdown = createShutdownHandler({ httpServer, engine, exit, log });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");

    expect(first).toBe(second);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("received SIGTERM, shutting down");
    expect(httpServer.close).toHaveBeenCalledTimes(1);
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    resolveEngineClose?.();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    closeCallback?.();
    await first;

    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(events).toEqual([
      "log:received SIGTERM, shutting down",
      "server.close",
      "engine.close",
      "exit:0",
    ]);
  });
});
