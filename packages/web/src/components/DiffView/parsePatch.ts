export type LineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

export interface ParsedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks: Hunk[];
  isBinary: boolean;
}

interface PendingFile {
  diffOldPath?: string;
  diffNewPath?: string;
  diffOldPrefix?: string;
  diffNewPrefix?: string;
  minusPath?: string;
  plusPath?: string;
  renameFrom?: string;
  renameTo?: string;
  minusDevNull: boolean;
  plusDevNull: boolean;
  isBinary: boolean;
  hunks: Hunk[];
}

function decodeQuotedPath(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      result += ch;
      continue;
    }
    const next = value[++i];
    if (next === undefined) {
      result += "\\";
    } else if (next === "n") {
      result += "\n";
    } else if (next === "r") {
      result += "\r";
    } else if (next === "t") {
      result += "\t";
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let j = 0; j < 2 && /[0-7]/.test(value[i + 1] ?? ""); j++) {
        octal += value[++i];
      }
      result += String.fromCharCode(parseInt(octal, 8));
    } else {
      result += next;
    }
  }
  return result;
}

function readPathToken(input: string, start: number): { path: string; end: number } | null {
  let i = start;
  while (input[i] === " ") i++;
  if (i >= input.length) return null;
  if (input[i] === "\"") {
    i++;
    let raw = "";
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === "\\" && i + 1 < input.length) {
        raw += ch + input[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === "\"") return { path: decodeQuotedPath(raw), end: i + 1 };
      raw += ch;
      i++;
    }
    return null;
  }
  const startPath = i;
  while (i < input.length && input[i] !== " ") i++;
  return { path: input.slice(startPath, i), end: i };
}

function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const first = readPathToken(line, "diff --git ".length);
  if (!first) return null;
  const second = readPathToken(line, first.end);
  if (!second) return null;
  return { oldPath: first.path, newPath: second.path };
}

function splitPrefix(path: string): { prefix?: string; path: string } {
  const slash = path.indexOf("/");
  if (slash <= 0) return { path };
  return { prefix: path.slice(0, slash), path: path.slice(slash + 1) };
}

function normalizeDiffPaths(oldPath: string, newPath: string): {
  oldPath: string;
  newPath: string;
  oldPrefix?: string;
  newPrefix?: string;
} {
  const oldParts = splitPrefix(oldPath);
  const newParts = splitPrefix(newPath);
  if (oldParts.prefix && newParts.prefix && oldParts.prefix !== newParts.prefix) {
    return {
      oldPath: oldParts.path,
      newPath: newParts.path,
      oldPrefix: oldParts.prefix,
      newPrefix: newParts.prefix,
    };
  }
  return { oldPath, newPath };
}

function stripKnownPrefix(path: string, prefix: string | undefined): string {
  if (prefix && path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1);
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function parsePatchPathLine(line: string, marker: "--- " | "+++ "): string | null {
  if (!line.startsWith(marker)) return null;
  const body = line.slice(marker.length);
  const token = readPathToken(body, 0);
  if (!token) return null;
  if (body.trimStart().startsWith("\"")) return token.path;
  return token.path.split("\t", 1)[0] ?? token.path;
}

export function parsePatch(raw: string): ParsedFile[] {
  if (!raw) return [];
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const files: ParsedFile[] = [];
  let current: PendingFile | null = null;
  let currentHunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  function pushHunk(): void {
    if (current && currentHunk) {
      current.hunks.push(currentHunk);
    }
    currentHunk = null;
  }

  function finalize(): void {
    if (!current) return;
    pushHunk();
    let status: FileStatus;
    let path: string;
    let oldPath: string | undefined;
    if (current.isBinary) {
      status = "binary";
      path = current.renameTo ?? current.diffNewPath ?? current.diffOldPath ?? "";
    } else if (current.minusDevNull) {
      status = "added";
      path = current.plusPath ?? current.diffNewPath ?? "";
    } else if (current.plusDevNull) {
      status = "deleted";
      path = current.minusPath ?? current.diffOldPath ?? "";
    } else {
      const a = current.renameFrom ?? current.minusPath ?? current.diffOldPath;
      const b = current.renameTo ?? current.plusPath ?? current.diffNewPath;
      path = b ?? a ?? "";
      if (a && b && a !== b) {
        status = "renamed";
        oldPath = a;
      } else {
        status = "modified";
      }
    }
    const file: ParsedFile = {
      path,
      status,
      hunks: current.hunks,
      isBinary: current.isBinary,
    };
    if (oldPath !== undefined) file.oldPath = oldPath;
    files.push(file);
    current = null;
  }

  for (const line of lines) {
    const diffMatch = parseDiffGitLine(line);
    if (diffMatch) {
      finalize();
      const normalized = normalizeDiffPaths(diffMatch.oldPath, diffMatch.newPath);
      current = {
        diffOldPath: normalized.oldPath,
        diffNewPath: normalized.newPath,
        diffOldPrefix: normalized.oldPrefix,
        diffNewPrefix: normalized.newPrefix,
        minusDevNull: false,
        plusDevNull: false,
        isBinary: false,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) {
      pushHunk();
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      const oldStart = m && m[1] ? parseInt(m[1], 10) : 0;
      const oldLines = m && m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const newStart = m && m[3] ? parseInt(m[3], 10) : 0;
      const newLines = m && m[4] !== undefined ? parseInt(m[4], 10) : 1;
      currentHunk = {
        header: line,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (currentHunk) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        currentHunk.lines.push({ kind: "add", text: line.slice(1), newNo });
        newNo++;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ kind: "del", text: line.slice(1), oldNo });
        oldNo++;
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({
          kind: "context",
          text: line.slice(1),
          oldNo,
          newNo,
        });
        oldNo++;
        newNo++;
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      const path = parsePatchPathLine(line, "--- ");
      if (path === "/dev/null") {
        current.minusDevNull = true;
      } else if (path) {
        current.minusPath = stripKnownPrefix(path, current.diffOldPrefix);
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = parsePatchPathLine(line, "+++ ");
      if (path === "/dev/null") {
        current.plusDevNull = true;
      } else if (path) {
        current.plusPath = stripKnownPrefix(path, current.diffNewPrefix);
      }
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.renameFrom = stripKnownPrefix(line.slice("rename from ".length), current.diffOldPrefix);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.renameTo = stripKnownPrefix(line.slice("rename to ".length), current.diffNewPrefix);
      continue;
    }
  }
  finalize();
  return files;
}
