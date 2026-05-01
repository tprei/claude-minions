import type { SessionType } from "./types";

export function sessionTypeColor(type: SessionType): string {
  switch (type) {
    case "engine":
      return "text-emerald-700 dark:text-emerald-400";
    case "web":
      return "text-sky-700 dark:text-sky-400";
    case "docs":
      return "text-amber-700 dark:text-amber-400";
    case "other":
      return "text-slate-700 dark:text-slate-400";
  }
}
