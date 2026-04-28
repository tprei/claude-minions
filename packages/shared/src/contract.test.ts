import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const SHARED_SRC_DIR = path.dirname(__filename);
const SHARED_PKG_DIR = path.resolve(SHARED_SRC_DIR, "..");
const WEB_REST_PATH = path.resolve(SHARED_PKG_DIR, "..", "web", "src", "transport", "rest.ts");
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

describe("web rest.ts references the shared types its endpoints exchange", () => {
  const restSrc = readFileSync(WEB_REST_PATH, "utf8");

  const ENDPOINT_TYPE_PAIRS: ReadonlyArray<{ endpoint: string; type: string }> = [
    { endpoint: "POST   /api/sessions",                  type: "CreateSessionRequest" },
    { endpoint: "POST   /api/sessions/variants",         type: "CreateVariantsRequest" },
    { endpoint: "POST   /api/commands",                  type: "Command" },
    { endpoint: "POST   /api/commands -> result",        type: "CommandResult" },
    { endpoint: "GET    /api/sessions/:slug/transcript", type: "TranscriptEvent" },
    { endpoint: "GET    /api/sessions/:slug/diff",       type: "WorkspaceDiff" },
    { endpoint: "GET    /api/sessions/:slug/pr",         type: "PullRequestPreview" },
    { endpoint: "GET    /api/sessions/:slug/readiness",  type: "MergeReadiness" },
    { endpoint: "POST   /api/memories",                  type: "CreateMemoryRequest" },
    { endpoint: "PATCH  /api/memories/:id/review",       type: "MemoryReviewCommand" },
    { endpoint: "PATCH  /api/config/runtime",            type: "RuntimeOverrides" },
    { endpoint: "GET    /api/config/runtime",            type: "RuntimeConfigResponse" },
    { endpoint: "POST   /api/entrypoints",               type: "RegisterEntrypointRequest" },
    { endpoint: "GET    /api/version",                   type: "VersionInfo" },
    { endpoint: "GET    /api/stats",                     type: "GlobalStats" },
    { endpoint: "GET    /api/readiness/summary",         type: "ReadinessSummary" },
    { endpoint: "GET    /api/loops",                     type: "LoopDefinition" },
  ];

  for (const { endpoint, type } of ENDPOINT_TYPE_PAIRS) {
    it(`${endpoint} -> ${type}`, () => {
      const importBlock = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'][^"']+["']/g;
      let imported = false;
      let m: RegExpExecArray | null;
      while ((m = importBlock.exec(restSrc)) !== null) {
        const inside = m[1] ?? "";
        const names = inside.split(",").map((n) => n.trim().replace(/\s+as\s+\w+$/, ""));
        if (names.includes(type)) {
          imported = true;
          break;
        }
      }
      assert.ok(
        imported,
        `web/src/transport/rest.ts does not import shared type "${type}" needed for endpoint ${endpoint}`,
      );
    });
  }
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
