import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diskUsage } from "./diskUsage.js";

describe("diskUsage", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "disk-usage-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test("returns missing=true with bytes=0 when path does not exist", async () => {
    const result = await diskUsage(path.join(tmpRoot, "absent"));
    assert.equal(result.missing, true);
    assert.equal(result.bytes, 0);
  });

  test("returns the exact size of a single file", async () => {
    const file = path.join(tmpRoot, "single.bin");
    const payload = Buffer.alloc(1234, 7);
    await fs.writeFile(file, payload);

    const result = await diskUsage(file);
    assert.equal(result.missing, false);
    assert.equal(result.bytes, 1234);
  });

  test("sums the sizes of files in a nested directory tree", async () => {
    const a = path.join(tmpRoot, "tree", "a.txt");
    const b = path.join(tmpRoot, "tree", "sub", "b.txt");
    const c = path.join(tmpRoot, "tree", "sub", "deep", "c.txt");
    await fs.mkdir(path.dirname(c), { recursive: true });
    await fs.writeFile(a, Buffer.alloc(10));
    await fs.writeFile(b, Buffer.alloc(20));
    await fs.writeFile(c, Buffer.alloc(30));

    const result = await diskUsage(path.join(tmpRoot, "tree"));
    assert.equal(result.missing, false);
    assert.equal(result.bytes, 60);
  });

  test("does not follow symlinks", async () => {
    const target = path.join(tmpRoot, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "big.bin"), Buffer.alloc(5000));

    const root = path.join(tmpRoot, "root");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "small.txt"), Buffer.alloc(40));
    await fs.symlink(target, path.join(root, "link-to-target"));

    const result = await diskUsage(root);
    assert.equal(result.missing, false);
    assert.equal(result.bytes, 40, "symlink target must not be traversed");
  });
});
