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
  minusPath?: string;
  plusPath?: string;
  minusDevNull: boolean;
  plusDevNull: boolean;
  isBinary: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string, prefix: string): string {
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  return p;
}

export function parsePatch(raw: string): ParsedFile[] {
  if (!raw) return [];
  const lines = raw.split("\n");
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
      path = current.diffNewPath ?? current.diffOldPath ?? "";
    } else if (current.minusDevNull) {
      status = "added";
      path = current.plusPath ?? current.diffNewPath ?? "";
    } else if (current.plusDevNull) {
      status = "deleted";
      path = current.minusPath ?? current.diffOldPath ?? "";
    } else {
      const a = current.minusPath ?? current.diffOldPath;
      const b = current.plusPath ?? current.diffNewPath;
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
    const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffMatch) {
      finalize();
      current = {
        diffOldPath: diffMatch[1],
        diffNewPath: diffMatch[2],
        minusDevNull: false,
        plusDevNull: false,
        isBinary: false,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("--- ")) {
      pushHunk();
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        current.minusDevNull = true;
      } else {
        current.minusPath = stripPrefix(path, "a/");
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      pushHunk();
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        current.plusDevNull = true;
      } else {
        current.plusPath = stripPrefix(path, "b/");
      }
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.isBinary = true;
      continue;
    }
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
    if (!currentHunk) continue;
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
  }
  finalize();
  return files;
}
