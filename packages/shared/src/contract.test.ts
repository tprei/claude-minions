import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const SHARED_SRC_DIR = path.dirname(__filename);
const SHARED_PKG_DIR = path.resolve(SHARED_SRC_DIR, "..");
const LINT_SCRIPT = path.resolve(SHARED_PKG_DIR, "scripts", "check-no-inline-bodies.mjs");

const PUBLIC_MODULES = [
  "api",
  "diff",
  "doctor",
  "event",
  "format",
  "push",
  "transcript",
  "version",
] as const;

const STALE_MODULES = [
  "checkpoint",
  "cleanup",
  "command",
  "dag",
  "loop",
  "memory",
  "runtime-config",
  "screenshot",
  "session",
  "sidecar",
] as const;

describe("shared/index.ts public surface", () => {
  it("exports only the current engine-port contract modules", () => {
    const indexSrc = readFileSync(path.join(SHARED_SRC_DIR, "index.ts"), "utf8");
    const missing = PUBLIC_MODULES.filter((m) => !indexSrc.includes(`./${m}.js`));
    const stale = STALE_MODULES.filter((m) => indexSrc.includes(`./${m}.js`));
    assert.deepEqual(
      missing,
      [],
      `index.ts is missing public modules: ${missing.join(", ")}.`,
    );
    assert.deepEqual(
      stale,
      [],
      `index.ts exports stale pre-port modules: ${stale.join(", ")}.`,
    );
  });
});

describe("inline fetch body lint", () => {
  it("no web file ships an inline JSON.stringify body without a shared *Request/*Command/*Response import", () => {
    const r = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: "utf8" });
    assert.equal(
      r.status,
      0,
      `check-no-inline-bodies.mjs reported violations:\n${r.stdout}${r.stderr}`,
    );
  });
});
