import fs from "node:fs";
import path from "node:path";

const LINE = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/;

export function loadDotenv(file: string, env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith("#")) continue;
    const m = raw.match(LINE);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

export function loadDotenvFiles(cwd: string = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    loadDotenv(path.resolve(cwd, name));
  }
}
