type Resolver = () => void;

export class KeyedMutex {
  private chains = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release: Resolver = () => {};
    const next = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => next);
    this.chains.set(key, chained);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === chained) {
        this.chains.delete(key);
      }
    }
  }

  isLocked(key: string): boolean {
    return this.chains.has(key);
  }

  forceRelease(key: string): void {
    this.chains.delete(key);
  }
}
