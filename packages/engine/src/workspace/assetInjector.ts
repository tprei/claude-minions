import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureDir, pathExists } from "../util/fs.js";

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "providers", "assets");

const ALIASES: [src: string, dst: string][] = [
  ["instructions.md", "AGENTS.md"],
  ["instructions.md", "CLAUDE.md"],
  ["instructions.md", ".cursor/rules/instructions.md"],
];

const EXCLUDE_HEADER = "# minions-injected (auto, do not commit)";

async function resolveGitDir(targetDir: string): Promise<string | null> {
  const dotGit = path.join(targetDir, ".git");
  const stat = await fs.stat(dotGit).catch(() => null);
  if (!stat) return null;
  if (stat.isDirectory()) return dotGit;
  if (stat.isFile()) {
    const text = await fs.readFile(dotGit, "utf8");
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m || !m[1]) return null;
    const p = m[1].trim();
    return path.isAbsolute(p) ? p : path.resolve(targetDir, p);
  }
  return null;
}

async function appendExcludes(targetDir: string, paths: string[]): Promise<void> {
  const gitDir = await resolveGitDir(targetDir);
  if (!gitDir) return;
  const excludePath = path.join(gitDir, "info", "exclude");
  await ensureDir(path.dirname(excludePath));
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    /* missing file → create */
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const toAdd: string[] = [];
  if (!have.has(EXCLUDE_HEADER)) toAdd.push(EXCLUDE_HEADER);
  for (const p of paths) {
    if (!have.has(p)) toAdd.push(p);
  }
  if (toAdd.length === 0) return;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fs.writeFile(excludePath, existing + sep + toAdd.join("\n") + "\n", "utf8");
}

export async function injectAssets(targetDir: string): Promise<void> {
  await ensureDir(targetDir);
  const injected: string[] = [];

  const entries = await fs.readdir(ASSETS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(ASSETS_DIR, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (!(await pathExists(dst))) {
      await fs.copyFile(src, dst);
    }
    injected.push(entry.name);
  }

  for (const [srcName, dstRel] of ALIASES) {
    const src = path.join(ASSETS_DIR, srcName);
    const dst = path.join(targetDir, dstRel);
    if (!(await pathExists(src))) continue;
    if (!(await pathExists(dst))) {
      await ensureDir(path.dirname(dst));
      await fs.copyFile(src, dst);
    }
    injected.push(dstRel.split("/")[0] ?? dstRel);
  }

  const unique = Array.from(new Set(injected));
  await appendExcludes(targetDir, unique);
}
