import fs from "node:fs";
import path from "node:path";

export interface EngineMarker {
  pid: number;
  startedAt: string;
  version: string;
}

function markerPath(workspace: string): string {
  return path.join(workspace, ".minions", "engine.state");
}

export function readMarker(workspace: string): EngineMarker | null {
  const file = markerPath(workspace);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj["pid"] !== "number" ||
    typeof obj["startedAt"] !== "string" ||
    typeof obj["version"] !== "string"
  ) {
    return null;
  }
  return { pid: obj["pid"], startedAt: obj["startedAt"], version: obj["version"] };
}

export function writeMarker(workspace: string, marker: EngineMarker): void {
  const file = markerPath(workspace);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(marker), "utf8");
  fs.renameSync(tmp, file);
}

export function clearMarker(workspace: string): void {
  const file = markerPath(workspace);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
