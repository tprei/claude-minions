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

export async function injectAssets(targetDir: string): Promise<void> {
  await ensureDir(targetDir);

  const entries = await fs.readdir(ASSETS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(ASSETS_DIR, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (!(await pathExists(dst))) {
      await fs.copyFile(src, dst);
    }
  }

  for (const [srcName, dstRel] of ALIASES) {
    const src = path.join(ASSETS_DIR, srcName);
    const dst = path.join(targetDir, dstRel);
    if (!(await pathExists(src))) continue;
    if (!(await pathExists(dst))) {
      await ensureDir(path.dirname(dst));
      await fs.copyFile(src, dst);
    }
  }
}
