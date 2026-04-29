import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PRSummary } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { parseGithubRemote } from "../github/parseRemote.js";
import { onPrUpdated as handlePrUpdated } from "./prLifecycle.js";
import { CiBabysitter } from "./babysitter.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const LOG_TAIL_BYTES = 4096;

export interface CiSubsystem {
  poll: (slug: string) => Promise<void>;
  onPrUpdated: (slug: string) => Promise<void>;
}

interface GhCheck {
  name: string;
  state: string;
  bucket: string;
  workflow: string;
  link: string;
}

interface GhPrView {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  title: string;
}

function mapPrState(state: string): PRSummary["state"] {
  const upper = state.toUpperCase();
  if (upper === "MERGED") return "merged";
  if (upper === "CLOSED") return "closed";
  return "open";
}

function tailUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: GH_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
  });
  return stdout;
}

export function createCiSubsystem(deps: SubsystemDeps): SubsystemResult<CiSubsystem> {
  const { ctx, log, db } = deps;
  const sessionRepo = new SessionRepo(db);
  const babysitter = new CiBabysitter(ctx, log);

  async function fetchPrAndChecks(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ pr: GhPrView; checks: GhCheck[] }> {
    const repoSlug = `${owner}/${repo}`;
    const [prJson, checksJson] = await Promise.all([
      runGh([
        "pr", "view", String(prNumber),
        "--repo", repoSlug,
        "--json", "number,url,state,isDraft,baseRefName,headRefName,headRefOid,title",
      ]),
      runGh([
        "pr", "checks", String(prNumber),
        "--repo", repoSlug,
        "--json", "name,state,bucket,workflow,link",
        "--watch=false",
      ]).catch((err) => {
        log.warn("gh pr checks failed", { prNumber, err: (err as Error).message });
        return "[]";
      }),
    ]);

    const pr = JSON.parse(prJson) as GhPrView;
    const checks = JSON.parse(checksJson) as GhCheck[];
    return { pr, checks };
  }

  async function fetchFailedLogs(owner: string, repo: string, head: string): Promise<string> {
    try {
      const listJson = await runGh([
        "run", "list",
        "--repo", `${owner}/${repo}`,
        "--branch", head,
        "--status", "failure",
        "--limit", "1",
        "--json", "databaseId",
      ]);
      const runs = JSON.parse(listJson) as { databaseId: number }[];
      const runId = runs[0]?.databaseId;
      if (!runId) return "";
      const logs = await runGh([
        "run", "view", String(runId),
        "--repo", `${owner}/${repo}`,
        "--log-failed",
      ]).catch(() => "");
      return tailUtf8(logs, LOG_TAIL_BYTES);
    } catch (err) {
      log.warn("ci log fetch failed", { head, err: (err as Error).message });
      return "";
    }
  }

  function hasRunningFixCi(slug: string): boolean {
    return ctx.sessions.list().some((s) => {
      const meta = s.metadata;
      if (meta["kind"] !== "fix-ci") return false;
      if (meta["forSession"] !== slug) return false;
      return s.status !== "completed" && s.status !== "failed" && s.status !== "cancelled";
    });
  }

  async function poll(slug: string): Promise<void> {
    const session = ctx.sessions.get(slug);
    if (!session || !session.pr || !session.repoId) return;

    const repos = ctx.repos();
    const repo = repos.find((r) => r.id === session.repoId);
    if (!repo?.remote) return;

    const parsed = parseGithubRemote(repo.remote);
    if (!parsed) {
      log.warn("ci poll: cannot parse remote", { slug, remote: repo.remote });
      return;
    }

    const { owner, repo: repoName } = parsed;
    const prNumber = session.pr.number;

    let prData: GhPrView;
    let checks: GhCheck[];
    try {
      const result = await fetchPrAndChecks(owner, repoName, prNumber);
      prData = result.pr;
      checks = result.checks;
    } catch (err) {
      log.warn("ci poll error", { slug, err: (err as Error).message });
      return;
    }

    const refreshedPr: PRSummary = {
      number: prData.number,
      url: prData.url,
      state: mapPrState(prData.state),
      draft: prData.isDraft,
      base: prData.baseRefName,
      head: prData.headRefName,
      title: prData.title,
    };
    const previousPrState = session.pr?.state ?? null;
    sessionRepo.setPr(slug, refreshedPr);

    if (previousPrState === "open" && refreshedPr.state === "merged") {
      await ctx.landing.onUpstreamMerged(slug).catch((err) => {
        log.warn("onUpstreamMerged failed", { slug, err: (err as Error).message });
      });
    }

    const failed = checks.filter((c) => c.bucket === "fail");
    const fresh = ctx.sessions.get(slug);
    if (!fresh) return;

    if (failed.length > 0 && !fresh.attention.find((a) => a.kind === "ci_failed")) {
      const failNames = failed.map((c) => c.name).join(", ");
      const attention = [
        ...fresh.attention,
        {
          kind: "ci_failed" as const,
          message: `CI checks failed: ${failNames}`,
          raisedAt: new Date().toISOString(),
        },
      ];
      sessionRepo.setAttention(slug, attention);

      const updated = ctx.sessions.get(slug);
      if (updated) {
        ctx.bus.emit({ kind: "session_updated", session: updated });
      }

      const autoFix = ctx.runtime.effective()["ciAutoFix"];
      if (autoFix === true && !hasRunningFixCi(slug)) {
        const head = prData.headRefName;
        const logs = await fetchFailedLogs(owner, repoName, head);
        const prompt = `CI is failing on PR #${prNumber} for branch ${head}. Failing checks: ${failNames}.

Log tail:
${logs}

Fix the failing CI checks. Edit code as needed, run pnpm typecheck/test locally, then commit and push to the same branch (origin/${head}). Do not open a new PR.`;

        await ctx.sessions.create({
          mode: "task",
          prompt,
          repoId: session.repoId,
          baseBranch: session.branch,
          parentSlug: slug,
          metadata: { kind: "fix-ci", forSession: slug, prNumber },
        }).catch((e) => {
          log.warn("ci auto-fix session spawn failed", { slug, err: (e as Error).message });
        });
      }
    } else {
      const updated = ctx.sessions.get(slug);
      if (updated) {
        ctx.bus.emit({ kind: "session_updated", session: updated });
      }
    }

    await handlePrUpdated(slug, ctx, log);
  }

  async function onPrUpdated(slug: string): Promise<void> {
    await handlePrUpdated(slug, ctx, log);
  }

  babysitter.start();

  return {
    api: { poll, onPrUpdated },
    onShutdown() {
      babysitter.stop();
    },
  };
}
