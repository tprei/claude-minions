export interface TokenBucketOpts {
  capacity: number;
  refillPerSec: number;
  now?: () => number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefill: number;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: TokenBucketOpts) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? (() => Date.now());
    this.tokens = opts.capacity;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const added = elapsed * this.refillPerSec;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }

  acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        resolve();
      });
      this.scheduleWaiterDrain();
    });
  }

  private scheduleWaiterDrain(): void {
    if (this.waiters.length === 0) return;
    const msPerToken = 1000 / this.refillPerSec;
    setTimeout(() => {
      this.drainWaiters();
    }, msPerToken);
  }

  private drainWaiters(): void {
    this.refill();
    while (this.waiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const waiter = this.waiters.shift()!;
      waiter();
    }
    if (this.waiters.length > 0) {
      this.scheduleWaiterDrain();
    }
  }
}
