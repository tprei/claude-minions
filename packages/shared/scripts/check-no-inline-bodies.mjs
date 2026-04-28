#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_SRC = process.env.MINIONS_WEB_SRC
  ? path.resolve(process.env.MINIONS_WEB_SRC)
  : path.resolve(__dirname, "..", "..", "web", "src");

const SHARED_NAMED_TYPE_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']@minions\/shared["']/g;
const LOCAL_NAMED_TYPE_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'](?:\.\.?\/)[^"']+["']/g;
const TYPE_NAME_RE = /\b\w+(?:Request|Command|Response|Envelope)\b/;
const CALL_RE = /\b(?:apiFetch|fetch)\s*\(/g;
const INLINE_BODY_RE = /\bbody\s*:\s*JSON\.stringify\s*\(\s*\{/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === "node_modules" || ent.name === "dist") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(p);
    } else if (/\.tsx?$/.test(ent.name)) {
      yield p;
    }
  }
}

function lineNumberAt(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function importsSharedTypedBody(src) {
  for (const re of [SHARED_NAMED_TYPE_RE, LOCAL_NAMED_TYPE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (TYPE_NAME_RE.test(m[1])) return true;
    }
  }
  return false;
}

const violations = [];
for (const file of walk(WEB_SRC)) {
  const src = readFileSync(file, "utf8");
  const sharedTyped = importsSharedTypedBody(src);
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src)) !== null) {
    const start = m.index;
    const window = src.slice(start, start + 200);
    if (!INLINE_BODY_RE.test(window)) continue;
    if (sharedTyped) continue;
    violations.push(`${path.relative(process.cwd(), file)}:${lineNumberAt(src, start)}`);
  }
}

if (violations.length === 0) process.exit(0);

console.error("Inline fetch/apiFetch body literals without a shared *Request/*Command/*Response import:");
for (const v of violations) console.error("  " + v);
process.exit(1);
