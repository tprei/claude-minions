import type { SessionType } from "./types";

export function formatSessionType(type: SessionType): string {
  switch (type) {
    case "engine":
      return "Engine";
    case "web":
      return "Web";
    case "docs":
      return "Docs";
    case "other":
      return "Other";
  }
}
