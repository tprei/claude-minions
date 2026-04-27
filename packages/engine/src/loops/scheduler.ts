import type { LoopDefinition } from "@minions/shared";

export function shouldRun(
  loop: LoopDefinition,
  now: number,
  slotsAvailable: boolean,
): boolean {
  if (!loop.enabled) return false;
  if (!slotsAvailable) return false;
  if (!loop.nextRunAt) return true;
  return new Date(loop.nextRunAt).getTime() <= now;
}

export function computeBackoff(loop: LoopDefinition): number {
  const failures = loop.consecutiveFailures;
  const raw = loop.intervalSec * Math.pow(2, failures);
  return Math.min(raw, 86400);
}

export function computeNextRun(loop: LoopDefinition, now: number): string {
  const delaySec = computeBackoff(loop);
  return new Date(now + delaySec * 1000).toISOString();
}
