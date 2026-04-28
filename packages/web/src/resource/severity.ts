export type Severity = "ok" | "warn" | "crit";

export function severity(value: number, warn: number, crit: number): Severity {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

export const SEVERITY_COLORS: Record<Severity, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-err",
};

export const SEVERITY_STROKES: Record<Severity, string> = {
  ok: "rgb(var(--ok))",
  warn: "rgb(var(--warn))",
  crit: "rgb(var(--err))",
};

export function worstSeverity(...severities: Severity[]): Severity {
  if (severities.includes("crit")) return "crit";
  if (severities.includes("warn")) return "warn";
  return "ok";
}
