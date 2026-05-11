import type { Claim } from "./types.js";

export interface ClaimConflict {
  left: Claim;
  right: Claim;
}

export function findClaimConflicts(left: readonly Claim[], right: readonly Claim[]): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];

  for (const leftClaim of left) {
    for (const rightClaim of right) {
      if (leftClaim.mode === "read" && rightClaim.mode === "read") continue;
      if (claimScopesOverlap(leftClaim.scope, rightClaim.scope)) {
        conflicts.push({ left: leftClaim, right: rightClaim });
      }
    }
  }

  return conflicts;
}

export function claimScopesOverlap(left: string, right: string): boolean {
  if (left === right) return true;

  const leftPrefix = directoryPrefix(left);
  const rightPrefix = directoryPrefix(right);

  if (leftPrefix && right.startsWith(leftPrefix)) return true;
  if (rightPrefix && left.startsWith(rightPrefix)) return true;

  return false;
}

function directoryPrefix(scope: string): string | null {
  if (scope.endsWith("/**")) return scope.slice(0, -2);
  if (scope.endsWith("/*")) return scope.slice(0, -1);
  return null;
}
