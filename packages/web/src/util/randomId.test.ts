import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./randomId.js";

const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
  vi.restoreAllMocks();
});

describe("randomId", () => {
  it("uses crypto.randomUUID when available", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "uuid-1" },
    });

    expect(randomId()).toBe("uuid-1");
  });

  it("falls back to timestamp and random suffix", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
    vi.spyOn(Date, "now").mockReturnValue(123456);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(randomId()).toBe("2n9c-i");
  });
});
