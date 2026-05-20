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

  it("falls back to crypto.getRandomValues when randomUUID is unavailable", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues(target: Uint8Array) {
          target.set([0, 1, 2, 3]);
          return target;
        },
      },
    });

    expect(randomId()).toMatch(/^00010203(?:00){12}$/);
  });

  it("throws when Web Crypto is unavailable", () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });

    expect(() => randomId()).toThrow("crypto.randomUUID or crypto.getRandomValues is required");
  });
});
