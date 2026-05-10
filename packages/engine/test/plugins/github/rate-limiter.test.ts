import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TokenBucket } from "../../../src/plugins/github/rate-limiter.js";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to capacity acquires immediately", async () => {
    const now = vi.fn(() => 0);
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now });

    // All 3 should resolve without advancing time
    const p1 = bucket.acquire();
    const p2 = bucket.acquire();
    const p3 = bucket.acquire();
    await expect(Promise.all([p1, p2, p3])).resolves.toBeDefined();
  });

  it("blocks when capacity is exhausted until refill", async () => {
    let t = 0;
    const now = () => t;
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1, now });

    // Drain capacity
    await bucket.acquire();
    await bucket.acquire();

    let resolved = false;
    const waiting = bucket.acquire().then(() => { resolved = true; });

    // Nothing resolved yet
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance to just under 1 full second — not enough for 1 token
    t = 900;
    vi.advanceTimersByTime(900);
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance to 1000ms (exactly 1 token at 1/s)
    t = 1000;
    vi.advanceTimersByTime(100);
    await waiting;
    expect(resolved).toBe(true);
  });

  it("caps tokens at capacity on refill", async () => {
    let t = 0;
    const now = () => t;
    const bucket = new TokenBucket({ capacity: 5, refillPerSec: 10, now });

    // Drain all
    for (let i = 0; i < 5; i++) await bucket.acquire();

    // Advance far in time — should cap at capacity 5
    t = 10000;
    vi.advanceTimersByTime(10000);

    // Should allow 5 immediate acquires
    const promises = Array.from({ length: 5 }, () => bucket.acquire());
    await expect(Promise.all(promises)).resolves.toBeDefined();
  });

  it("drains FIFO under contention", async () => {
    let t = 0;
    const now = () => t;
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1, now });

    // Drain
    await bucket.acquire();

    const order: number[] = [];
    const w1 = bucket.acquire().then(() => order.push(1));
    const w2 = bucket.acquire().then(() => order.push(2));
    const w3 = bucket.acquire().then(() => order.push(3));

    // Advance 3 seconds worth of time
    t = 1000;
    vi.advanceTimersByTime(1000);
    await w1;
    t = 2000;
    vi.advanceTimersByTime(1000);
    await w2;
    t = 3000;
    vi.advanceTimersByTime(1000);
    await w3;

    expect(order).toEqual([1, 2, 3]);
  });
});
