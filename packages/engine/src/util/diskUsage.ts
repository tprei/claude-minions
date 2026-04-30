import fs from "node:fs/promises";
import path from "node:path";

export interface DuResult {
  bytes: number;
  missing: boolean;
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly cap: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

export async function diskUsage(absPath: string): Promise<DuResult> {
  const sem = new Semaphore(8);
  let total = 0;
  let missing = false;

  async function withSem<T>(fn: () => Promise<T>): Promise<T> {
    await sem.acquire();
    try {
      return await fn();
    } finally {
      sem.release();
    }
  }

  async function visit(p: string, isRoot: boolean): Promise<void> {
    let stat: import("node:fs").Stats;
    try {
      stat = await withSem(() => fs.lstat(p));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        if (isRoot) missing = true;
        return;
      }
      throw err;
    }

    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      total += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;

    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await withSem(() => fs.readdir(p, { withFileTypes: true }));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return;
      throw err;
    }

    await Promise.all(entries.map((entry) => visit(path.join(p, entry.name), false)));
  }

  await visit(absPath, true);
  return { bytes: total, missing };
}
