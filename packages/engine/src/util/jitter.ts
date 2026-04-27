export function fullJitter(base: number, attempt: number, cap: number): number {
  const exp = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

export function applyJitterPct(value: number, pct: number): number {
  if (pct <= 0) return value;
  const span = value * pct;
  return Math.max(0, value + (Math.random() * 2 - 1) * span);
}
