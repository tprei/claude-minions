import type { Session } from "@minions/shared";

export type SessionType =
  | "security"
  | "reliability"
  | "feature"
  | "frontend"
  | "engine"
  | "dx"
  | "other";

export const SESSION_TYPE_ORDER: readonly SessionType[] = [
  "security",
  "reliability",
  "feature",
  "frontend",
  "engine",
  "dx",
  "other",
];

export const SESSION_TYPE_LABEL: Record<SessionType, string> = {
  security: "Security",
  reliability: "Reliability",
  feature: "Feature",
  frontend: "Frontend",
  engine: "Engine",
  dx: "DX",
  other: "Other",
};

export function classifySession(session: Session): SessionType {
  const title = session.title.toLowerCase();
  const branch = (session.branch ?? "").toLowerCase();
  const prompt = session.prompt.toLowerCase();
  const haystack = `${title} ${branch} ${prompt}`;

  if (/^fix\((security|auth|crypto|csrf|xss)/.test(title)) return "security";
  if (/\bt5\d\b/.test(haystack) && /(security|auth|crypto|csrf|xss)/.test(haystack)) return "security";
  if (haystack.includes("security") || haystack.includes("auth")) return "security";

  if (haystack.includes("engine/") || branch.startsWith("engine/")) return "engine";

  if (haystack.includes("packages/web/") || haystack.includes("pwa/") || haystack.includes("web/")) return "frontend";

  if (/^(chore|test)[(:]/.test(title)) return "dx";

  if (/^fix[(:]/.test(title)) return "reliability";

  if (/^feat[(:]/.test(title)) return "feature";

  return "other";
}
