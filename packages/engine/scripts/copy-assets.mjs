// Copy non-TS asset files into dist/ after tsc.
// tsc's outDir mirroring only handles .ts/.tsx; the asset injector and any
// future loaders need the markdown/JSON/etc. siblings.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const COPY_EXTS = new Set([".md", ".json", ".sql", ".txt"]);

function copyTree(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, name);
    const d = path.join(dstDir, name);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) {
      copyTree(s, d);
      continue;
    }
    if (COPY_EXTS.has(path.extname(name))) {
      fs.copyFileSync(s, d);
    }
  }
}

copyTree(SRC, DIST);
