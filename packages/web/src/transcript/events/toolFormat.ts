import type { ToolResultEvent } from "@minions/shared";
import { createContext } from "react";

export interface InlineArgOpts {
  worktreePath?: string;
}

export const WorktreePathContext = createContext<string | undefined>(undefined);

const KEY_PRIORITY = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
  "text",
] as const;

export function stripWorktree(p: string, root?: string): string {
  if (!root) return p;
  if (p === root) return "";
  if (p.startsWith(root + "/")) return p.slice(root.length + 1);
  return p;
}

export function singleLine(text: string, max = 60): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length > max) return collapsed.slice(0, max - 1) + "…";
  return collapsed;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function lastPathSegments(p: string, n: number): string {
  const segs = p.split("/").filter((s) => s.length > 0);
  return "…/" + segs.slice(-n).join("/");
}

function genericPreview(input: Record<string, unknown>): string {
  for (const key of KEY_PRIORITY) {
    const v = input[key];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) return singleLine(trimmed, 80);
    }
  }
  return "";
}

export function formatInlineArg(
  toolName: string,
  input: Record<string, unknown>,
  opts?: InlineArgOpts,
): string {
  if (!input) return "";
  const root = opts?.worktreePath;
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write": {
      const filePath = typeof input.file_path === "string" ? input.file_path : "";
      if (!filePath) return genericPreview(input);
      const stripped = stripWorktree(filePath, root);
      if (stripped.length > 80) return lastPathSegments(stripped, 3);
      return stripped;
    }
    case "Glob": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      if (!pattern) return genericPreview(input);
      return truncate(pattern, 80);
    }
    case "Grep": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const path = typeof input.path === "string" ? input.path : "";
      const truncatedPattern = truncate(pattern, 40);
      const quoted = `"${truncatedPattern}"`;
      if (!path) return quoted;
      const strippedPath = stripWorktree(path, root);
      if (!strippedPath) return quoted;
      return `${quoted} ${strippedPath}`;
    }
    case "Bash": {
      const command = typeof input.command === "string" ? input.command : "";
      if (!command) return genericPreview(input);
      return singleLine(command, 60);
    }
    default:
      return genericPreview(input);
  }
}

function readLineCount(body: string): number {
  if (body.length === 0) return 0;
  const newlines = (body.match(/\n/g) || []).length;
  return body.endsWith("\n") ? newlines : newlines + 1;
}

function nonEmptyLineCount(body: string): number {
  if (body.length === 0) return 0;
  return body.split("\n").filter((l) => l.length > 0).length;
}

export function formatResultSummary(
  toolName: string,
  result: ToolResultEvent | undefined,
): { text: string; tone: "ok" | "error" | "partial" | "pending" } {
  if (!result) return { text: "", tone: "pending" };
  if (result.status === "error") {
    let text = "(failed)";
    if (toolName === "Read" && /not found|ENOENT/i.test(result.body)) {
      text = "(file not found)";
    } else if (toolName === "Bash") {
      text = "(exit 1)";
    }
    return { text, tone: "error" };
  }
  if (result.status === "partial") {
    return { text: "(truncated)", tone: "partial" };
  }
  const body = result.body || "";
  switch (toolName) {
    case "Read": {
      return { text: `(${readLineCount(body)} lines)`, tone: "ok" };
    }
    case "Glob": {
      return { text: `(${nonEmptyLineCount(body)} files)`, tone: "ok" };
    }
    case "Grep": {
      const lines = body.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return { text: "(0 lines)", tone: "ok" };
      if (lines.every((l) => /^[^\s:]+:\d+:/.test(l))) {
        const files = new Set<string>();
        for (const l of lines) {
          const m = l.match(/^([^\s:]+):/);
          if (m && m[1]) files.add(m[1]);
        }
        return {
          text: `(${lines.length} matches in ${files.size} files)`,
          tone: "ok",
        };
      }
      if (lines.every((l) => !/:\d+:/.test(l))) {
        return { text: `(${lines.length} files)`, tone: "ok" };
      }
      return { text: `(${lines.length} lines)`, tone: "ok" };
    }
    case "Bash": {
      return { text: `(exit 0, ${nonEmptyLineCount(body)} lines)`, tone: "ok" };
    }
    case "Edit":
      return { text: "(ok)", tone: "ok" };
    case "Write": {
      if (body.length > 0 && /\b(wrote|written|lines?)\b/i.test(body)) {
        return { text: `(${readLineCount(body)} lines written)`, tone: "ok" };
      }
      return { text: "(ok)", tone: "ok" };
    }
    default: {
      const firstLine = body.split("\n", 1)[0] ?? "";
      const trimmed = firstLine.length > 40 ? firstLine.slice(0, 39) + "…" : firstLine;
      return { text: `(${trimmed})`, tone: "ok" };
    }
  }
}
