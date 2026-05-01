import type { ResourceSnapshot } from "@minions/shared";

export type ResourceKind = "memory" | "disk";

export interface ResourceAlertThresholds {
  memoryPct: number;
  diskPct: number;
  cooldownMs: number;
}

export type LastFiredMap = Record<ResourceKind, number>;

export interface ResourceAlertDecision {
  pct: number;
  threshold: number;
}

export interface ResourceAlertResult {
  memory: ResourceAlertDecision | null;
  disk: ResourceAlertDecision | null;
}

function memoryPct(snapshot: ResourceSnapshot): number | null {
  const { usedBytes, limitBytes } = snapshot.memory;
  if (limitBytes <= 0) return null;
  return (usedBytes / limitBytes) * 100;
}

function diskPct(snapshot: ResourceSnapshot): number | null {
  const { usedBytes, totalBytes } = snapshot.disk;
  if (totalBytes <= 0) return null;
  return (usedBytes / totalBytes) * 100;
}

function decide(
  pct: number | null,
  threshold: number,
  lastFiredAt: number,
  cooldownMs: number,
  now: number,
): ResourceAlertDecision | null {
  if (pct === null) return null;
  if (pct < threshold) return null;
  if (now - lastFiredAt < cooldownMs) return null;
  return { pct, threshold };
}

export function decideResourceAlert(
  snapshot: ResourceSnapshot,
  thresholds: ResourceAlertThresholds,
  lastFired: LastFiredMap,
  now: number,
): ResourceAlertResult {
  return {
    memory: decide(
      memoryPct(snapshot),
      thresholds.memoryPct,
      lastFired.memory,
      thresholds.cooldownMs,
      now,
    ),
    disk: decide(
      diskPct(snapshot),
      thresholds.diskPct,
      lastFired.disk,
      thresholds.cooldownMs,
      now,
    ),
  };
}
