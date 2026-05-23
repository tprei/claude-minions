import { describe, expect, it } from "vitest";
import { claimScopesOverlap, findClaimConflicts } from "../../src/domain/claims.js";
import type { Claim } from "../../src/domain/types.js";

describe("claimScopesOverlap — bare directory scope", () => {
  it("bare directory overlaps a nested file path", () => {
    expect(claimScopesOverlap("src", "src/app/foo.ts")).toBe(true);
  });

  it("bare directory does not overlap a path that only shares a prefix without a separator", () => {
    expect(claimScopesOverlap("src", "srcfoo.ts")).toBe(false);
  });

  it("bare directory overlaps itself", () => {
    expect(claimScopesOverlap("src", "src")).toBe(true);
  });

  it("nested bare directory overlaps deeper path", () => {
    expect(claimScopesOverlap("src/app", "src/app/foo.ts")).toBe(true);
  });

  it("nested bare directory does not overlap sibling directory", () => {
    expect(claimScopesOverlap("src/app", "src/apptest/foo.ts")).toBe(false);
  });

  it("file path does not overlap bare directory that is its ancestor in reverse", () => {
    expect(claimScopesOverlap("src/app/foo.ts", "src")).toBe(true);
  });

  it("glob /** still overlaps nested paths", () => {
    expect(claimScopesOverlap("src/**", "src/app/foo.ts")).toBe(true);
  });

  it("glob /* still overlaps nested paths", () => {
    expect(claimScopesOverlap("src/*", "src/foo.ts")).toBe(true);
  });
});

describe("findClaimConflicts — write/write conflict for nested scope", () => {
  it("detects write/write conflict when left scope is bare directory and right is nested file", () => {
    const left: Claim[] = [{ scope: "src", mode: "write" }];
    const right: Claim[] = [{ scope: "src/app/foo.ts", mode: "write" }];

    const conflicts = findClaimConflicts(left, right);
    expect(conflicts).toHaveLength(1);
  });

  it("no conflict for read/read even with overlapping bare directory", () => {
    const left: Claim[] = [{ scope: "src", mode: "read" }];
    const right: Claim[] = [{ scope: "src/app/foo.ts", mode: "read" }];

    const conflicts = findClaimConflicts(left, right);
    expect(conflicts).toHaveLength(0);
  });

  it("no conflict for non-overlapping bare directories", () => {
    const left: Claim[] = [{ scope: "src", mode: "write" }];
    const right: Claim[] = [{ scope: "lib/foo.ts", mode: "write" }];

    const conflicts = findClaimConflicts(left, right);
    expect(conflicts).toHaveLength(0);
  });

  it("no false conflict for paths sharing only a string prefix without segment boundary", () => {
    const left: Claim[] = [{ scope: "src", mode: "write" }];
    const right: Claim[] = [{ scope: "srcfoo.ts", mode: "write" }];

    const conflicts = findClaimConflicts(left, right);
    expect(conflicts).toHaveLength(0);
  });
});
