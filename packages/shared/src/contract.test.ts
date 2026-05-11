import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const SHARED_SRC_DIR = path.dirname(__filename);
const SHARED_PKG_DIR = path.resolve(SHARED_SRC_DIR, "..");
const LINT_SCRIPT = path.resolve(SHARED_PKG_DIR, "scripts", "check-no-inline-bodies.mjs");

describe("shared/index.ts re-exports every module in src/", () => {
  it("has no orphaned modules", () => {
    const indexSrc = readFileSync(path.join(SHARED_SRC_DIR, "index.ts"), "utf8");
    const modules = readdirSync(SHARED_SRC_DIR)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
      .map((f) => f.replace(/\.ts$/, ""));
    const missing = modules.filter((m) => !indexSrc.includes(`./${m}.js`));
    assert.deepEqual(
      missing,
      [],
      `index.ts is missing re-exports for: ${missing.join(", ")}. Add export * from "./<name>.js" or remove the file.`,
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
