import { createHash } from "node:crypto";
import type { DAG, DAGNode } from "@minions/shared";

const DIACRITICS_RE = /[̀-ͯ]/g;

export function slugifyText(text: string, maxLen?: number): string {
  if (!text) return "";
  let s = text
    .normalize("NFKD")
    .replace(DIACRITICS_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (maxLen !== undefined && s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/-+$/, "");
  }
  return s;
}

export function extractNodeKey(
  node: { title: string; prompt: string },
  maxLen: number,
): string {
  const h1 = node.prompt.match(/^#\s+(.+)$/m);
  if (h1) {
    const slug = slugifyText(h1[1] ?? "", maxLen);
    if (slug) return slug;
  }

  const titleWords = node.title
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6)
    .join(" ");
  const titleSlug = slugifyText(titleWords, maxLen);
  if (titleSlug) return titleSlug;

  const hash = createHash("sha256").update(node.prompt).digest("hex").slice(0, 6);
  return slugifyText(hash, maxLen);
}

export function deriveShipPrefix(dag: { rootSessionSlug?: string; title?: string }): string {
  if (dag.rootSessionSlug && dag.rootSessionSlug.length > 0) {
    const alnum = dag.rootSessionSlug.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (alnum.length >= 6) return alnum.slice(0, 6);
  }
  return createHash("sha256")
    .update(dag.title ?? "")
    .digest("hex")
    .slice(0, 6);
}

export function deriveDagTaskSlug(dag: DAG, node: DAGNode): string {
  const prefix = deriveShipPrefix(dag);
  const budget = 40 - prefix.length - 1;
  const nodeKey = extractNodeKey(node, budget);
  if (!nodeKey) return prefix;
  return `${prefix}-${nodeKey}`;
}
