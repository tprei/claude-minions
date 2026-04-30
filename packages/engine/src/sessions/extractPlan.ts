import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineContext } from "../context.js";
import type { TranscriptEvent, ToolCallEvent } from "@minions/shared";

export interface ExtractedPlan {
  plan: string;
  source: "file" | "transcript";
}

function isMdWriteCall(ev: TranscriptEvent): ev is ToolCallEvent {
  if (ev.kind !== "tool_call") return false;
  if (ev.toolKind !== "write") return false;
  const fp = ev.input["file_path"];
  return typeof fp === "string" && fp.endsWith(".md");
}

function normalize(p: string): string {
  return p.split(path.sep).join("/");
}

export async function extractPlanFromThink(
  ctx: EngineContext,
  slug: string,
): Promise<ExtractedPlan> {
  const events = ctx.sessions.transcript(slug);

  let planPath: string | null = null;
  let mdPath: string | null = null;

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || !isMdWriteCall(ev)) continue;
    const fp = ev.input["file_path"] as string;
    if (normalize(fp).includes("/.claude/plans/")) {
      if (planPath === null) planPath = fp;
    } else if (mdPath === null) {
      mdPath = fp;
    }
  }

  const candidate = planPath ?? mdPath;

  if (candidate !== null) {
    try {
      const plan = await fs.readFile(candidate, "utf8");
      return { plan, source: "file" };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.kind === "assistant_text" && ev.text.trim().length >= 200) {
      return { plan: ev.text, source: "transcript" };
    }
  }

  return { plan: "", source: "transcript" };
}
