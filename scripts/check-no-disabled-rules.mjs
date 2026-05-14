import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".vite", "dev-dist"]);
const EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const FORBIDDEN = [
  "eslint" + "-disable",
  "@ts" + "-ignore",
  "@ts" + "-expect-error",
  "@ts" + "-nocheck",
];

function hasExtension(path) {
  for (const extension of EXTENSIONS) {
    if (path.endsWith(extension)) return true;
  }
  return false;
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await collectFiles(join(dir, entry.name)));
    } else if (entry.isFile() && hasExtension(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

const failures = [];
for (const file of await collectFiles(ROOT)) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const token of FORBIDDEN) {
      if (line.includes(token)) {
        failures.push(`${file.slice(ROOT.length + 1)}:${index + 1}: ${token}`);
      }
    }
  });
}

if (failures.length > 0) {
  console.error("Forbidden lint/typecheck disable directives found:");
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
