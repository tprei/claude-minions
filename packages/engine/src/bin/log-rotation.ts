import fs from "node:fs";
import path from "node:path";

export interface RotatingFileWriterOptions {
  maxBytes: number;
  keep: number;
}

export class RotatingFileWriter {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private fd: number | null;
  private size: number;

  constructor(filePath: string, opts: RotatingFileWriterOptions) {
    if (opts.maxBytes <= 0) throw new Error("maxBytes must be > 0");
    if (opts.keep < 1) throw new Error("keep must be >= 1");
    this.filePath = filePath;
    this.maxBytes = opts.maxBytes;
    this.keep = opts.keep;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, "a");
    this.size = fs.fstatSync(this.fd).size;
  }

  write(chunk: Buffer | string): void {
    if (this.fd === null) throw new Error("writer is closed");
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.size + buf.length > this.maxBytes && this.size > 0) {
      this.rotate();
    }
    fs.writeSync(this.fd, buf);
    this.size += buf.length;
  }

  async close(): Promise<void> {
    if (this.fd === null) return;
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
  }

  private rotate(): void {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
      this.fd = null;
    }

    const overflow = `${this.filePath}.${this.keep + 1}`;
    if (fs.existsSync(overflow)) fs.rmSync(overflow, { force: true });

    for (let i = this.keep - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }

    if (fs.existsSync(this.filePath)) {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    }

    const dropped = `${this.filePath}.${this.keep + 1}`;
    if (fs.existsSync(dropped)) fs.rmSync(dropped, { force: true });

    this.fd = fs.openSync(this.filePath, "a");
    this.size = fs.fstatSync(this.fd).size;
  }
}

export class RingBuffer {
  private readonly capacity: number;
  private readonly items: string[];

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.capacity = capacity;
    this.items = [];
  }

  push(line: string): void {
    this.items.push(line);
    while (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  snapshot(): string[] {
    return this.items.slice();
  }
}
