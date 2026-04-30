import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearMarker, readMarker, writeMarker } from "./marker.js";

describe("lifecycle/marker", () => {
  let workspace: string;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "marker-test-"));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearMarker(workspace);
  });

  test("readMarker returns null when file is missing", () => {
    assert.equal(readMarker(workspace), null);
  });

  test("write then read round-trips the marker", () => {
    const marker = { pid: 12345, startedAt: "2026-05-01T00:00:00.000Z", version: "0.1.0" };
    writeMarker(workspace, marker);
    const got = readMarker(workspace);
    assert.deepEqual(got, marker);
  });

  test("clearMarker removes the file", () => {
    writeMarker(workspace, { pid: 1, startedAt: "2026-05-01T00:00:00.000Z", version: "0.1.0" });
    assert.ok(readMarker(workspace));
    clearMarker(workspace);
    assert.equal(readMarker(workspace), null);
  });

  test("clearMarker is a no-op when file does not exist", () => {
    assert.doesNotThrow(() => clearMarker(workspace));
  });

  test("readMarker returns null for malformed JSON", () => {
    const file = path.join(workspace, ".minions", "engine.state");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json", "utf8");
    assert.equal(readMarker(workspace), null);
  });

  test("readMarker returns null when fields are missing or wrong types", () => {
    const file = path.join(workspace, ".minions", "engine.state");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: "not-a-number", startedAt: "x", version: "y" }), "utf8");
    assert.equal(readMarker(workspace), null);
  });

  test("writeMarker leaves no tmp files behind on success", () => {
    writeMarker(workspace, { pid: 999, startedAt: "2026-05-01T00:00:00.000Z", version: "0.1.0" });
    const dir = path.join(workspace, ".minions");
    const entries = fs.readdirSync(dir);
    const stragglers = entries.filter((name) => name.startsWith("engine.state.tmp."));
    assert.deepEqual(stragglers, []);
    assert.ok(entries.includes("engine.state"));
  });

  test("writeMarker overwrites an existing marker atomically", () => {
    writeMarker(workspace, { pid: 1, startedAt: "2026-05-01T00:00:00.000Z", version: "0.1.0" });
    writeMarker(workspace, { pid: 2, startedAt: "2026-05-01T00:00:01.000Z", version: "0.2.0" });
    const got = readMarker(workspace);
    assert.deepEqual(got, { pid: 2, startedAt: "2026-05-01T00:00:01.000Z", version: "0.2.0" });
    const dir = path.join(workspace, ".minions");
    const entries = fs.readdirSync(dir);
    const stragglers = entries.filter((name) => name.startsWith("engine.state.tmp."));
    assert.deepEqual(stragglers, []);
  });
});
