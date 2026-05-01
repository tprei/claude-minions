import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AttentionFlag, DagNodeCiSummary, PRSummary } from "@minions/shared";
import type { SubsystemDeps, SubsystemResult } from "../wiring.js";
import { parseGithubRemote } from "../github/parseRemote.js";
import { onPrUpdated as handlePrUpdated } from "./prLifecycle.js";
import { CiBabysitter } from "./babysitter.js";
import { SessionRepo } from "../store/repos/sessionRepo.js";
import { DagRepo } from "../dag/model.js";

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

interface GhCheckRunRollup {
  __typename?: "CheckRun";
  name?: string;
  status?: string;
  conclusion?: string;
  workflowName?: string;
  detailsUrl?: string;
}

interface GhStatusContextRollup {
  __typename?: "StatusContext";
  context?: string;
  state?: string;
  targetUrl?: string;
}

type GhRollupEntry = GhCheckRunRollup | GhStatusContextRollup;

interface GhPrView {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  title: string;
  statusCheckRollup: GhRollupEntry[] | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
}

const FAIL_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const PASS_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const FAIL_STATES = new Set(["FAILURE", "ERROR"]);

function isCheckRun(entry: GhRollupEntry): entry is GhCheckRunRollup {
  if (entry.__typename === "CheckRun") return true;
  if (entry.__typename === "StatusContext") return false;
  return "conclusion" in entry || "workflowName" in entry || "detailsUrl" in entry;
}

export function rollupToChecks(rollup: GhRollupEntry[] | null | undefined): GhCheck[] {
  if (!rollup) return [];
  return rollup.map((entry) => {
    if (isCheckRun(entry)) {
      const conclusion = (entry.conclusion ?? "").toUpperCase();
      const status = (entry.status ?? "").toUpperCase();
      const bucket = FAIL_CONCLUSIONS.has(conclusion)
        ? "fail"
        : PASS_CONCLUSIONS.has(conclusion)
          ? "pass"
          : "pending";
      return {
        name: entry.name ?? "",
        state: conclusion || status,
        bucket,
        workflow: entry.workflowName ?? "",
        link: entry.detailsUrl ?? "",
      };
    }
    const state = (entry.state ?? "").toUpperCase();
    const bucket = FAIL_STATES.has(state)
      ? "fail"
      : state === "SUCCESS"
        ? "pass"
        : "pending";
    return {
      name: entry.context ?? "",
      state,
      bucket,
      workflow: "",
      link: entry.targetUrl ?? "",
    };
  });
}

export function summarizeChecks(checks: GhCheck[]): Pick<DagNodeCiSummary, "state" | "counts" | "checks"> {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const slim: DagNodeCiSummary["checks"] = [];
  for (const c of checks) {
    const bucket: DagNodeCiSummary["checks"][number]["bucket"] =
      c.bucket === "pass" ? "pass" : c.bucket === "fail" ? "fail" : "pending";
    if (bucket === "pass") passed++;
    else if (bucket === "fail") failed++;
    else pending++;
    slim.push({ name: c.name, bucket });
  }
  const state: DagNodeCiSummary["state"] =
    failed > 0 ? "failing" : pending > 0 || checks.length === 0 ? "pending" : "passing";
  return { state, counts: { passed, failed, pending }, checks: slim };
}

function ciSummaryEqual(
  a: DagNodeCiSummary | null | undefined,
  b: DagNodeCiSummary | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.state !== b.state) return false;
  if (a.counts.passed !== b.counts.passed) return false;
  if (a.counts.failed !== b.counts.failed) return false;
  if (a.counts.pending !== b.counts.pending) return false;
  if (a.prNumber !== b.prNumber) return false;
  if (a.prUrl !== b.prUrl) return false;
  if (a.checks.length !== b.checks.length) return false;
  for (let i = 0; i < a.checks.length; i++) {
    const ca = a.checks[i]!;
    const cb = b.checks[i]!;
    if (ca.name !== cb.name) return false;
    if (ca.bucket !== cb.bucket) return false;
  }
  return true;
}

export const DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS = 3;

export interface CheckBuckets {
  failed: string[];
  pending: string[];
  passed: string[];
}

export function bucketChecks(checks: GhCheck[]): CheckBuckets {
  return {
    failed: checks.filter((c) => c.bucket === "fail").map((c) => c.name),
    pending: checks.filter((c) => c.bucket === "pending").map((c) => c.name),
    passed: checks.filter((c) => c.bucket === "pass").map((c) => c.name),
  };
}

export type SelfHealDecision =
  | { kind: "noop"; reason: "self-heal-disabled" | "still-pending" | "no-checks-yet" }
  | { kind: "success" }
  | { kind: "retry"; nextAttempts: number; failedNames: string[] }
  | { kind: "exhausted"; failedNames: string[]; attempts: number };

export interface SelfHealInput {
  selfHealEnabled: boolean;
  attempts: number;
  maxAttempts: number;
  buckets: CheckBuckets;
}

export function decideSelfHeal(input: SelfHealInput): SelfHealDecision {
  const { selfHealEnabled, attempts, maxAttempts, buckets } = input;
  if (!selfHealEnabled) return { kind: "noop", reason: "self-heal-disabled" };
  const totalChecks = buckets.failed.length + buckets.pending.length + buckets.passed.length;
  if (totalChecks === 0) return { kind: "noop", reason: "no-checks-yet" };
  if (buckets.pending.length > 0) return { kind: "noop", reason: "still-pending" };
  if (buckets.failed.length === 0) return { kind: "success" };
  if (attempts >= maxAttempts) {
    return { kind: "exhausted", failedNames: buckets.failed, attempts };
  }
  return { kind: "retry", nextAttempts: attempts + 1, failedNames: buckets.failed };
}

export type AutoMergeDecision =
  | { kind: "merge" }
  | {
      kind: "skip";
      reason:
        | "flag-disabled"
        | "ineligible-session"
        | "pr-not-open"
        | "pr-draft"
        | "ci-not-clean"
        | "review-blocking"
        | "not-mergeable";
    };

export interface AutoMergeInput {
  flagEnabled: boolean;
  prState: PRSummary["state"];
  prDraft: boolean;
  ciState: DagNodeCiSummary["state"];
  failedCount: number;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  sessionKind: string | undefined;
  sessionMode: string | undefined;
}

export function decideAutoMerge(input: AutoMergeInput): AutoMergeDecision {
  if (!input.flagEnabled) return { kind: "skip", reason: "flag-disabled" };
  if (input.sessionKind === "fix-ci" || input.sessionMode === "rebase-resolver") {
    return { kind: "skip", reason: "ineligible-session" };
  }
  if (input.prState !== "open") return { kind: "skip", reason: "pr-not-open" };
  if (input.prDraft) return { kind: "skip", reason: "pr-draft" };
  if (input.ciState !== "passing" || input.failedCount > 0) {
    return { kind: "skip", reason: "ci-not-clean" };
  }
  if ((input.reviewDecision ?? "").toUpperCase() === "CHANGES_REQUESTED") {
    return { kind: "skip", reason: "review-blocking" };
  }
  if ((input.mergeStateStatus ?? "").toUpperCase() !== "CLEAN") {
    return { kind: "skip", reason: "ci-not-clean" };
  }
  if ((input.mergeable ?? "").toUpperCase() !== "MERGEABLE") {
    return { kind: "skip", reason: "not-mergeable" };
  }
  return { kind: "merge" };
}

export type CiAttentionUpdate =
  | { kind: "noop" }
  | { kind: "add"; attention: AttentionFlag[] }
  | { kind: "update"; attention: AttentionFlag[]; previousMessage: string }
  | { kind: "clear"; attention: AttentionFlag[]; previousMessage: string };

export function computeCiAttentionUpdate(
  currentAttention: AttentionFlag[],
  failedCheckNames: string[],
  raisedAt: string,
): CiAttentionUpdate {
  const existingFailedIdx = currentAttention.findIndex((a) => a.kind === "ci_failed");
  if (failedCheckNames.length > 0) {
    const message = `CI checks failed: ${failedCheckNames.join(", ")}`;
    if (existingFailedIdx >= 0) {
      const previous = currentAttention[existingFailedIdx]!;
      const attention = currentAttention.map((a, i) =>
        i === existingFailedIdx ? { ...a, message, raisedAt } : a,
      );
      return { kind: "update", attention, previousMessage: previous.message };
    }
    const attention = [
      ...currentAttention,
      { kind: "ci_failed" as const, message, raisedAt },
    ];
    return { kind: "add", attention };
  }
  if (existingFailedIdx >= 0) {
    const previous = currentAttention[existingFailedIdx]!;
    const attention = currentAttention.filter((a) => a.kind !== "ci_failed");
    return { kind: "clear", attention, previousMessage: previous.message };
  }
  return { kind: "noop" };
}

export function applyCiPassedAttention(
  current: AttentionFlag[],
  raisedAt: string,
): AttentionFlag[] | null {
  const filtered = current.filter((a) => a.kind !== "ci_pending" && a.kind !== "ci_failed");
  const hasPassed = filtered.some((a) => a.kind === "ci_passed");
  if (hasPassed && filtered.length === current.length) return null;
  if (hasPassed) return filtered;
  return [...filtered, { kind: "ci_passed", message: "All checks passed", raisedAt }];
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

export function readAttempts(metadata: Record<string, unknown>): number {
  const raw = metadata["ciSelfHealAttempts"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

export function buildSelfHealPrompt(args: {
  prNumber: number;
  failedNames: string[];
  logs: string;
}): string {
  const failedList = args.failedNames.join(", ");
  const logsBlock = args.logs.length > 0 ? `\n\nLog tail:\n${args.logs}\n` : "\n";
  return `CI failed on PR #${args.prNumber}. Failed checks: ${failedList}.${logsBlock}\nFix the failing CI checks and push to the same branch (do NOT open a new PR).`;
}

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: GH_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
  });
  return stdout;
}

export function createCiSubsystem(deps: SubsystemDeps): SubsystemResult<CiSubsystem> {
  const { ctx, log, db, bus } = deps;
  const sessionRepo = new SessionRepo(db);
  const dagRepo = new DagRepo(db, bus);
  const babysitter = new CiBabysitter(ctx, log);

  async function fetchPrAndChecks(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ pr: GhPrView; checks: GhCheck[] }> {
    const repoSlug = `${owner}/${repo}`;
    const prJson = await runGh([
      "pr", "view", String(prNumber),
      "--repo", repoSlug,
      "--json", "number,url,state,isDraft,baseRefName,headRefName,headRefOid,title,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision",
    ]);

    const pr = JSON.parse(prJson) as GhPrView;
    const checks = rollupToChecks(pr.statusCheckRollup);
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

  function readSelfHealMaxAttempts(): number {
    const raw = ctx.runtime.effective()["ciSelfHealMaxAttempts"];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return DEFAULT_CI_SELF_HEAL_MAX_ATTEMPTS;
    }
    return Math.floor(raw);
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

    const fresh = ctx.sessions.get(slug);
    if (!fresh) return;

    const summary = summarizeChecks(checks);

    const dagNode = dagRepo.getNodeBySession(slug);
    if (dagNode) {
      const nextSummary: DagNodeCiSummary = {
        ...summary,
        prNumber: refreshedPr.number,
        prUrl: refreshedPr.url,
        updatedAt: new Date().toISOString(),
      };
      if (!ciSummaryEqual(dagNode.ciSummary, nextSummary)) {
        try {
          dagRepo.setNodeCiSummary(dagNode.id, nextSummary);
        } catch (err) {
          log.warn("ci poll: failed to update dag node ci summary", {
            slug,
            nodeId: dagNode.id,
            err: (err as Error).message,
          });
        }
      }
    }

    const buckets = bucketChecks(checks);
    const selfHealEnabled = fresh.metadata["selfHealCi"] === true;

    if (selfHealEnabled) {
      const attempts = readAttempts(fresh.metadata);
      const maxAttempts = readSelfHealMaxAttempts();
      const decision = decideSelfHeal({
        selfHealEnabled,
        attempts,
        maxAttempts,
        buckets,
      });

      if (decision.kind === "success") {
        await applySelfHealSuccess(slug);
      } else if (decision.kind === "retry") {
        await applySelfHealRetry(
          slug,
          decision.nextAttempts,
          decision.failedNames,
          owner,
          repoName,
          prData.headRefName,
          prNumber,
        );
      } else if (decision.kind === "exhausted") {
        await applySelfHealExhausted(slug, fresh.attention, decision.failedNames, decision.attempts);
      }
    } else {
      const raisedAt = new Date().toISOString();
      const update = computeCiAttentionUpdate(
        fresh.attention,
        buckets.failed,
        raisedAt,
      );

      if (update.kind !== "noop") {
        sessionRepo.setAttention(slug, update.attention);
      }

      if (update.kind === "clear") {
        ctx.audit.record(
          "system",
          "ci.attention.cleared",
          { kind: "session", id: slug },
          { previousMessage: update.previousMessage },
        );
      }

      const afterFailedUpdate = ctx.sessions.get(slug);
      if (afterFailedUpdate) {
        if (summary.state === "passing") {
          const next = applyCiPassedAttention(afterFailedUpdate.attention, raisedAt);
          if (next !== null) sessionRepo.setAttention(slug, next);
        } else if (afterFailedUpdate.attention.some((a) => a.kind === "ci_passed")) {
          const next = afterFailedUpdate.attention.filter((a) => a.kind !== "ci_passed");
          sessionRepo.setAttention(slug, next);
        }
      }

      const flagEnabled = ctx.runtime.effective()["autoMergeOnGreen"] === true;
      const sessionKindRaw = fresh.metadata["kind"];
      const decision = decideAutoMerge({
        flagEnabled,
        prState: refreshedPr.state,
        prDraft: refreshedPr.draft,
        ciState: summary.state,
        failedCount: summary.counts.failed,
        mergeable: prData.mergeable,
        mergeStateStatus: prData.mergeStateStatus,
        reviewDecision: prData.reviewDecision,
        sessionKind: typeof sessionKindRaw === "string" ? sessionKindRaw : undefined,
        sessionMode: fresh.mode,
      });
      if (decision.kind === "merge") {
        await applyAutoMerge(slug, owner, repoName, prNumber);
      }
    }

    const updated = ctx.sessions.get(slug);
    if (updated) {
      ctx.bus.emit({ kind: "session_updated", session: updated });
    }

    await handlePrUpdated(slug, ctx, log);
  }

  async function applyAutoMerge(
    slug: string,
    owner: string,
    repoName: string,
    prNumber: number,
  ): Promise<void> {
    try {
      await runGh([
        "api",
        "-X", "PUT",
        `repos/${owner}/${repoName}/pulls/${prNumber}/merge`,
        "-f", "merge_method=squash",
      ]);
    } catch (err) {
      log.warn("auto-merge failed", { slug, prNumber, err: (err as Error).message });
      ctx.audit.record(
        "system",
        "pr.auto-merge.failed",
        { kind: "session", id: slug },
        { prNumber, error: (err as Error).message },
      );
      return;
    }
    ctx.audit.record(
      "system",
      "pr.auto-merged",
      { kind: "session", id: slug },
      { prNumber, strategy: "squash" },
    );
  }

  async function applySelfHealSuccess(slug: string): Promise<void> {
    ctx.sessions.dismissAttention(slug, "ci_pending");
    const fresh = ctx.sessions.get(slug);
    if (fresh) {
      const next = applyCiPassedAttention(fresh.attention, new Date().toISOString());
      if (next !== null) sessionRepo.setAttention(slug, next);
    }
    ctx.sessions.setMetadata(slug, {
      selfHealCi: false,
      ciSelfHealConcluded: "success",
    });
    ctx.sessions.markCompleted(slug);
    ctx.audit.record(
      "system",
      "ci.self-heal.success",
      { kind: "session", id: slug },
    );
    try {
      await ctx.dags.onSessionCiTerminal(slug);
    } catch (err) {
      log.warn("ci self-heal: dag node landing failed", { slug, err: (err as Error).message });
    }
  }

  async function applySelfHealRetry(
    slug: string,
    nextAttempts: number,
    failedNames: string[],
    owner: string,
    repoName: string,
    head: string,
    prNumber: number,
  ): Promise<void> {
    ctx.sessions.setMetadata(slug, { ciSelfHealAttempts: nextAttempts });
    const logs = await fetchFailedLogs(owner, repoName, head);
    const prompt = buildSelfHealPrompt({ prNumber, failedNames, logs });

    try {
      await ctx.sessions.reply(slug, prompt);
    } catch (err) {
      log.warn("ci self-heal: failed to enqueue reply", { slug, err: (err as Error).message });
      return;
    }

    try {
      await ctx.sessions.kickReplyQueue(slug);
    } catch (err) {
      log.warn("ci self-heal: failed to kick reply queue", { slug, err: (err as Error).message });
      return;
    }

    ctx.audit.record(
      "system",
      "ci.self-heal.attempted",
      { kind: "session", id: slug },
      { attempt: nextAttempts, prNumber, failedChecks: failedNames },
    );
  }

  async function applySelfHealExhausted(
    slug: string,
    currentAttention: AttentionFlag[],
    failedNames: string[],
    attempts: number,
  ): Promise<void> {
    ctx.sessions.setMetadata(slug, {
      selfHealCi: false,
      ciSelfHealConcluded: "exhausted",
    });
    const withoutPending = currentAttention.filter((a) => a.kind !== "ci_pending");
    const update = computeCiAttentionUpdate(
      withoutPending,
      failedNames,
      new Date().toISOString(),
    );
    const next = update.kind === "noop" ? withoutPending : update.attention;
    sessionRepo.setAttention(slug, next);
    ctx.audit.record(
      "system",
      "ci.self-heal.exhausted",
      { kind: "session", id: slug },
      { attempts, failedChecks: failedNames },
    );
    try {
      await ctx.dags.onSessionCiTerminal(slug);
    } catch (err) {
      log.warn("ci self-heal exhausted: dag node update failed", {
        slug,
        err: (err as Error).message,
      });
    }
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
