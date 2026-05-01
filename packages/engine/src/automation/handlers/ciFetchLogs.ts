import path from "node:path";
import fs from "node:fs/promises";
import type { AutomationJob } from "@minions/shared";
import type { EngineContext } from "../../context.js";
import type { AutomationJobRepo } from "../../store/repos/automationJobRepo.js";
import { parseGithubRemote } from "../../github/parseRemote.js";
import type { JobHandler } from "../types.js";

const SUMMARY_MAX_CHARS = 200;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUN_ID_RE = /^[0-9]+$/;

export interface CiFetchLogsPayload {
  sessionSlug: string;
  runId: string;
  failedJobNames: string[];
}

export interface CiFetchLogsHandlerDeps {
  workspaceDir: string;
}

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

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, SUMMARY_MAX_CHARS);
  }
  return "";
}

export function createCiFetchLogsHandler(deps: CiFetchLogsHandlerDeps): JobHandler {
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

    const repoId = session.repoId ?? "";

    let logsByJob: Record<string, string> = {};
    try {
      const result = await ctx.github.fetchFailedLogs(repoId, runId);
      logsByJob = result.logsByJob;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const jobName of failedJobNames) {
        logsByJob[jobName] = `[failed to fetch log: ${msg}]`;
      }
    }

    const sections: string[] = [];
    let summary = "";
    for (const jobName of failedJobNames) {
      const logText = logsByJob[jobName] ?? `[failed to fetch log]`;
      sections.push(`=== ${jobName} ===\n${logText}`);
      if (summary === "") {
        summary = firstNonEmptyLine(logText) || jobName;
      }
    }

    const MAX_LOG_BYTES = 50 * 1024;
    const combined = sections.join("\n\n");
    const buf = Buffer.from(combined, "utf8");
    const consolidated = buf.length <= MAX_LOG_BYTES
      ? combined
      : buf.subarray(buf.length - MAX_LOG_BYTES).toString("utf8");

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
