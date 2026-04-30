import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RingBuffer, RotatingFileWriter } from "./log-rotation.js";

describe("log-rotation", () => {
  const roots: string[] = [];

  function makeRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minions-rot-"));
    roots.push(dir);
    return dir;
  }

  after(() => {
    for (const r of roots) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  describe("RotatingFileWriter", () => {
    test("rotates with keep=3 and drops the oldest file", async () => {
      const root = makeRoot();
      const file = path.join(root, "engine.log");
      const writer = new RotatingFileWriter(file, { maxBytes: 100, keep: 3 });
      const chunk = Buffer.alloc(60, "a");

      for (let i = 0; i < 8; i++) {
        writer.write(chunk);
      }
      await writer.close();

      assert.equal(fs.existsSync(file), true, "engine.log exists");
      assert.equal(fs.existsSync(`${file}.1`), true, ".1 exists");
      assert.equal(fs.existsSync(`${file}.2`), true, ".2 exists");
      assert.equal(fs.existsSync(`${file}.3`), true, ".3 exists");
      assert.equal(fs.existsSync(`${file}.4`), false, ".4 dropped");
    });

    test(".1 is the most recent rotated file", async () => {
      const root = makeRoot();
      const file = path.join(root, "engine.log");
      const writer = new RotatingFileWriter(file, { maxBytes: 10, keep: 3 });

      writer.write("AAAAAAAAAA");
      writer.write("BBBBBBBBBB");
      writer.write("CCCCCCCCCC");
      writer.write("DDDDDDDDDD");
      await writer.close();

      assert.equal(fs.readFileSync(file, "utf8"), "DDDDDDDDDD");
      assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "CCCCCCCCCC");
      assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "BBBBBBBBBB");
      assert.equal(fs.readFileSync(`${file}.3`, "utf8"), "AAAAAAAAAA");
    });
  });

  describe("RingBuffer", () => {
    test("snapshot returns last capacity items oldest-first after overflow", () => {
      const capacity = 200;
      const buf = new RingBuffer(capacity);
      const total = capacity + 10;

      for (let i = 0; i < total; i++) {
        buf.push(`line-${i}`);
      }

      const snap = buf.snapshot();
      assert.equal(snap.length, capacity);
      assert.equal(snap[0], `line-${total - capacity}`);
      assert.equal(snap[snap.length - 1], `line-${total - 1}`);
      for (let i = 0; i < snap.length; i++) {
        assert.equal(snap[i], `line-${total - capacity + i}`);
      }
    });

    test("snapshot returns a copy that is not affected by later pushes", () => {
      const buf = new RingBuffer(3);
      buf.push("a");
      buf.push("b");
      const snap = buf.snapshot();
      buf.push("c");
      buf.push("d");
      assert.deepEqual(snap, ["a", "b"]);
    });
  });
});
