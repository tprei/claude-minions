import { describe, it, expect } from "vitest";
import { parsePatch } from "../parsePatch.js";

describe("parsePatch", () => {
  it("returns [] for empty input", () => {
    expect(parsePatch("")).toEqual([]);
  });

  it("parses a single-file modified diff", () => {
    const raw = `diff --git a/src/foo.ts b/src/foo.ts
index 0000001..0000002 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const greeting = "hello";
-export function foo(): number { return 1; }
+export function foo(): number { return 2; }
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(1);
    const file = result[0]!;
    expect(file.path).toBe("src/foo.ts");
    expect(file.status).toBe("modified");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(3);
    expect(hunk.lines.map((l) => l.kind)).toEqual(["context", "del", "add"]);
    expect(hunk.lines[0]).toMatchObject({ kind: "context", oldNo: 1, newNo: 1 });
    expect(hunk.lines[1]).toMatchObject({ kind: "del", oldNo: 2 });
    expect(hunk.lines[2]).toMatchObject({ kind: "add", newNo: 2 });
  });

  it("splits multi-file diffs at file boundaries", () => {
    const raw = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,1 @@
-old2
+new2
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe("a.ts");
    expect(result[1]!.path).toBe("b.ts");
    expect(result[0]!.hunks).toHaveLength(1);
    expect(result[1]!.hunks).toHaveLength(1);
  });

  it("detects added files via /dev/null in ---", () => {
    const raw = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("added");
    expect(result[0]!.path).toBe("new.ts");
    expect(result[0]!.hunks[0]!.lines.map((l) => l.kind)).toEqual([
      "add",
      "add",
    ]);
  });

  it("detects deleted files via /dev/null in +++", () => {
    const raw = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 1234567..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("deleted");
    expect(result[0]!.path).toBe("gone.ts");
  });

  it("detects renamed files and populates oldPath", () => {
    const raw = `diff --git a/old/path.ts b/new/path.ts
similarity index 90%
rename from old/path.ts
rename to new/path.ts
index 1234567..89abcde 100644
--- a/old/path.ts
+++ b/new/path.ts
@@ -1,1 +1,1 @@
-old line
+new line
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("renamed");
    expect(result[0]!.path).toBe("new/path.ts");
    expect(result[0]!.oldPath).toBe("old/path.ts");
  });

  it("detects binary files", () => {
    const raw = `diff --git a/img.png b/img.png
index 1234567..89abcde 100644
Binary files a/img.png and b/img.png differ
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("binary");
    expect(result[0]!.isBinary).toBe(true);
    expect(result[0]!.hunks).toHaveLength(0);
    expect(result[0]!.path).toBe("img.png");
  });

  it("handles multiple hunks per file with continuing line numbers", () => {
    const raw = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -10,3 +10,3 @@
 line ten
-old eleven
+new eleven
@@ -50,2 +50,3 @@
 line fifty
+inserted fifty-one
 line fifty-one
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(1);
    const file = result[0]!;
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0]!.oldStart).toBe(10);
    expect(file.hunks[0]!.lines[0]).toMatchObject({
      kind: "context",
      oldNo: 10,
      newNo: 10,
    });
    expect(file.hunks[0]!.lines[1]).toMatchObject({ kind: "del", oldNo: 11 });
    expect(file.hunks[0]!.lines[2]).toMatchObject({ kind: "add", newNo: 11 });
    expect(file.hunks[1]!.oldStart).toBe(50);
    expect(file.hunks[1]!.lines[0]).toMatchObject({
      kind: "context",
      oldNo: 50,
      newNo: 50,
    });
    expect(file.hunks[1]!.lines[1]).toMatchObject({ kind: "add", newNo: 51 });
    expect(file.hunks[1]!.lines[2]).toMatchObject({
      kind: "context",
      oldNo: 51,
      newNo: 52,
    });
  });

  it("defaults to 1 line when ,b or ,d is omitted in hunk header", () => {
    const raw = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -5 +5 @@
-old
+new
`;
    const result = parsePatch(raw);
    const hunk = result[0]!.hunks[0]!;
    expect(hunk.oldStart).toBe(5);
    expect(hunk.oldLines).toBe(1);
    expect(hunk.newStart).toBe(5);
    expect(hunk.newLines).toBe(1);
  });

  it("skips '\\ No newline at end of file' markers", () => {
    const raw = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const result = parsePatch(raw);
    const hunk = result[0]!.hunks[0]!;
    expect(hunk.lines.map((l) => l.kind)).toEqual(["del", "add"]);
  });

  it("ignores preamble before the first diff --git", () => {
    const raw = `garbage line one
something else
diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,1 @@
-a
+b
`;
    const result = parsePatch(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("x.ts");
  });
});
