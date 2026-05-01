import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import { parseGithubRemote } from "../../github/parseRemote.js";
import type { JobHandler } from "../types.js";

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const TAIL_LINES = 200;
const MAX_LOG_BYTES = 50 * 1024;
const SUMMARY_MAX_CHARS = 200;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUN_ID_RE = /^[0-9]+$/;

export interface CiFetchLogsPayload {
  sessionSlug: string;
  runId: string;
  failedJobNames: string[];
}

export type RunGhFn = (args: string[]) => Promise<string>;

export interface CiFetchLogsHandlerDeps {
  workspaceDir: string;
  runGh?: RunGhFn;
}

const defaultRunGh: RunGhFn = async (args) => {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: GH_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
  });
  return stdout;
};

export function enqueueCiFetchLogs(
  repo: AutomationJobRepo,
  payload: CiFetchLogsPayload,
): AutomationJob {
  return repo.enqueue({
    kind: "ci-fetch-logs",
    targetKind: "session",
    targetId: payload.sessionSlug,
    payload: {
      sessionSlug: payload.sessionSlug,
      runId: payload.runId,
      failedJobNames: payload.failedJobNames,
    },
  });
}

function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

function clipTailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, SUMMARY_MAX_CHARS);
  }
  return "";
}

export function createCiFetchLogsHandler(deps: CiFetchLogsHandlerDeps): JobHandler {
  const runGh = deps.runGh ?? defaultRunGh;
  return async (job: AutomationJob, ctx: EngineContext): Promise<void> => {
    const payload = job.payload as Partial<CiFetchLogsPayload>;
    const slug = payload.sessionSlug;
    const runId = payload.runId;
    const failedJobNames = payload.failedJobNames;

    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw new Error(`ci-fetch-logs: invalid sessionSlug`);
    }
    if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
      throw new Error(`ci-fetch-logs: invalid runId`);
    }
    if (!Array.isArray(failedJobNames) || failedJobNames.length === 0) {
      throw new Error(`ci-fetch-logs: failedJobNames must be a non-empty array`);
    }

    const session = ctx.sessions.get(slug);
    if (!session) return;

    const repos = ctx.repos();
    const repoBinding = session.repoId
      ? repos.find((r) => r.id === session.repoId)
      : undefined;
    const parsed = repoBinding?.remote ? parseGithubRemote(repoBinding.remote) : null;
    if (!parsed) {
      throw new Error(`ci-fetch-logs: cannot resolve owner/repo for session ${slug}`);
    }

    const repoSlug = `${parsed.owner}/${parsed.repo}`;
    const sections: string[] = [];
    let summary = "";
    for (const jobName of failedJobNames) {
      try {
        const out = await runGh([
          "run", "view", runId,
          "--repo", repoSlug,
          "--log-failed",
          "--job", jobName,
        ]);
        const tail = tailLines(out, TAIL_LINES);
        sections.push(`=== ${jobName} ===\n${tail}`);
        if (summary === "") {
          summary = firstNonEmptyLine(tail) || jobName;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sections.push(`=== ${jobName} ===\n[failed to fetch log: ${msg}]`);
      }
    }

    const consolidated = clipTailBytes(sections.join("\n\n"), MAX_LOG_BYTES);
    const dir = path.join(deps.workspaceDir, ".minions", "ci-logs", slug);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${runId}.log`);
    await fs.writeFile(filePath, consolidated, "utf8");

    const fallbackSummary = failedJobNames[0] ?? "unknown failure";
    const finalSummary = summary || fallbackSummary;
    ctx.sessions.setMetadata(slug, {
      ciFailureLogPath: filePath,
      ciFailureSummary: finalSummary,
    });

    const selfHealEnabled = session.metadata["selfHealCi"] === true;
    if (!selfHealEnabled) return;

    await ctx.sessions.reply(
      slug,
      `Failure logs available at ${filePath}. First failure: ${finalSummary}. Use the file to diagnose.`,
    );
    await ctx.sessions.kickReplyQueue(slug);
  };
}
