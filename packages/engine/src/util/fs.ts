import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonl<T>(p: string): Promise<T[]> {
  const exists = await pathExists(p);
  if (!exists) return [];
  const buf = await fs.readFile(p, "utf8");
  const out: T[] = [];
  for (const line of buf.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export async function appendJsonl<T>(p: string, item: T): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, JSON.stringify(item) + "\n", "utf8");
}

export async function writeJsonlReplace<T>(p: string, items: T[]): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""), "utf8");
}

export async function copyDirRecursive(src: string, dst: string, opts: { overwrite?: boolean } = {}): Promise<void> {
  if (!(await pathExists(src))) return;
  await ensureDir(dst);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyDirRecursive(s, d, opts);
    } else if (e.isFile() || e.isSymbolicLink()) {
      if (!opts.overwrite && (await pathExists(d))) continue;
      await fs.copyFile(s, d);
    }
  }
}

export async function bytesAvailable(p: string): Promise<{ used: number; total: number }> {
  try {
    const stat = await fs.statfs(p);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return { used: total - free, total };
  } catch {
    return { used: 0, total: 0 };
  }
}
