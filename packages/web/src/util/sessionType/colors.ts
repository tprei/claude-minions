import type { SessionType } from "./types";

export function sessionTypeColor(type: SessionType): string {
  switch (type) {
    case "engine":
      return "text-emerald-500";
    case "web":
      return "text-sky-500";
    case "docs":
      return "text-amber-500";
    case "other":
      return "text-slate-500";
  }
}
