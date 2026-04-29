import type { SessionType } from "./types";

export function inferSessionType(title: string): SessionType {
  const t = title.toLowerCase();
  if (/\bengine\b/.test(t)) return "engine";
  if (/\b(web|ui|frontend|browser)\b/.test(t)) return "web";
  if (/\b(docs?|documentation|readme)\b/.test(t)) return "docs";
  return "other";
}
