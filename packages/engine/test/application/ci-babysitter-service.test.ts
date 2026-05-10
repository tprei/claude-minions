import { describe, expect, it, vi } from "vitest";
import { CIBabysitterService } from "../../src/application/ci-babysitter-service.js";
import { silentLogger } from "../test-helpers.js";
import { createLogger } from "../../src/observability/logger.js";
import type { Sink } from "../../src/observability/sinks.js";
import type { LogRecord } from "../../src/observability/types.js";

function makeCapturingSink(): { sink: Sink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: { write: (r) => { records.push(r); } }, records };
}
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import type { ContinueTaskInput } from "../../src/application/continue-task-service.js";
import type { CommandResult } from "../../src/application/commands.js";
import { GitHubApiError } from "../../src/plugins/github/github-client.js";
import type { GhCheckRun } from "../../src/plugins/github/github-client.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import type { Artifact } from "../../src/domain/types.js";

const NOW = "2026-05-06T12:00:00.000Z";
const now = () => NOW;

const TASK_ID = "wf-1:task";
const WORKFLOW_ID = "wf-1";
const OWNER = "acme";
const REPO = "app";
const HEAD_SHA = "abc123";
const PR_URL = "https://github.com/acme/app/pull/42";
const PR_NUMBER = 42;

function makeRepo() {
  return new InMemoryWorkflowRepository();
}

function makeGithub(overrides: {
  getPR?: () => Promise<{ number: number; url: string; headSha: string; headRef: string; baseRef: string; mergeable: boolean | null; mergeableState: string | null; state: string }>;
  listCheckRuns?: () => Promise<GhCheckRun[]>;
}) {
  return {
    getPR: overrides.getPR ?? vi.fn().mockResolvedValue({
      number: PR_NUMBER,
      url: PR_URL,
      headSha: HEAD_SHA,
      headRef: "feature",
      baseRef: "main",
      mergeable: true,
      mergeableState: "clean",
      state: "open",
    }),
    listCheckRuns: overrides.listCheckRuns ?? vi.fn().mockResolvedValue([]),
    findPRByHead: vi.fn(),
    createPR: vi.fn(),
    mergePR: vi.fn(),
  } as unknown as import("../../src/plugins/github/github-client.js").GitHubClient;
}

function makeContinueTaskService() {
  return {
    run: vi.fn().mockResolvedValue({ workflow: null, events: [] } as unknown as CommandResult),
  } as unknown as import("../../src/application/continue-task-service.js").ContinueTaskService;
}

function immediateSleep(_ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return Promise.resolve();
}

function abortingSleep(_durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((_, reject) => {
    if (signal.aborted) { reject(new Error("aborted")); return; }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

const FAST_CADENCE = {
  intervals: [{ afterMs: 0, everyMs: 10 }],
  maxHorizonMs: 10 * 60_000,
  noChecksBailMs: 5_000,
  confirmationDelayMs: 10,
};

async function makeTaskUpToFinalizing(repo: InMemoryWorkflowRepository, prArtifacts: Artifact[] = []) {
  const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, now);
  await repo.save(wf, []);

  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
  });
  return prArtifacts;
}

async function openPR(repo: InMemoryWorkflowRepository, extraArtifacts: Artifact[] = []) {
  const defaultPr: Artifact = { kind: "pr", ref: PR_URL, producedBy: "merge-service", createdAt: NOW };
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "open-review", taskId: TASK_ID, artifacts: [defaultPr, ...extraArtifacts], now: NOW },
  });
}

describe("CIBabysitterService", () => {
  it("attach is idempotent — second attach does not spawn duplicate consumer", async () => {
    const repo = makeRepo();
    const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, now);
    await repo.save(wf, []);

    const ctrl = new AbortController();
    const github = makeGithub({});
    const continueTaskService = makeContinueTaskService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    service.attach(WORKFLOW_ID);
    service.attach(WORKFLOW_ID);

    await new Promise((r) => setImmediate(r));
    ctrl.abort();

    expect(github.listCheckRuns).not.toHaveBeenCalled();
  });

  it("happy path — all checks success, no transition, no continue-task", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const applyCommandSpy = vi.fn((cmd: Parameters<typeof applyCommand>[1]) => applyCommand(repo, cmd));

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: applyCommandSpy,
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    const mergeConflictCalls = applyCommandSpy.mock.calls.filter(
      (c) => c[0].kind === "transition-task" && c[0].transition.kind === "merge-conflict",
    );
    expect(mergeConflictCalls).toHaveLength(0);
    expect(continueTaskService.run).not.toHaveBeenCalled();
  });

  it("failure path — failed check causes merge-conflict + ci-report + continue-task", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      {
        name: "ci/test",
        status: "completed",
        conclusion: "failure",
        output: { summary: "tests failed", text: "details here" },
      } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const applyCommandSpy = vi.fn((cmd: Parameters<typeof applyCommand>[1]) => applyCommand(repo, cmd));

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: applyCommandSpy,
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();

    const mergeConflictCalls = applyCommandSpy.mock.calls.filter(
      (c) => c[0].kind === "transition-task" && c[0].transition.kind === "merge-conflict",
    );
    expect(mergeConflictCalls).toHaveLength(1);

    const transition = (mergeConflictCalls[0]![0] as { transition: { artifacts: Artifact[] } }).transition;
    const ciReport = transition.artifacts.find((a: Artifact) => a.kind === "ci-report");
    expect(ciReport).toBeDefined();
    const reportRef = JSON.parse(ciReport!.ref) as { prNumber: number; failed: Array<{ name: string }> };
    expect(reportRef.prNumber).toBe(PR_NUMBER);
    expect(reportRef.failed[0]?.name).toBe("ci/test");

    expect(continueTaskService.run).toHaveBeenCalledOnce();
    const runInput = (continueTaskService.run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContinueTaskInput;
    expect(runInput.prompt).toContain(`PR #${PR_NUMBER}`);
    expect(runInput.prompt).toContain(PR_URL);
    expect(runInput.prompt.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("late arrival — first list has 1 success; after confirm 2 (1 success + 1 failure); failure path triggers", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);

    const ctrl = new AbortController();
    let callCount = 0;
    const listCheckRuns = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun];
      }
      return [
        { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
        { name: "lint", status: "completed", conclusion: "failure" } satisfies GhCheckRun,
      ];
    });
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const applyCommandSpy = vi.fn((cmd: Parameters<typeof applyCommand>[1]) => applyCommand(repo, cmd));

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: applyCommandSpy,
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();

    expect(continueTaskService.run).toHaveBeenCalledOnce();
    const runInput = (continueTaskService.run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ContinueTaskInput;
    expect(runInput.prompt).toContain("lint");
  });

  it("abort on transition out — pr-open → merged mid-poll; no further GitHub calls", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);

    const ctrl = new AbortController();
    let sleepCount = 0;
    const sleepFn = vi.fn().mockImplementation((_ms: number, signal: AbortSignal) => {
      sleepCount++;
      if (sleepCount >= 2) {
        return abortingSleep(999_999, signal);
      }
      return Promise.resolve();
    });

    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "in_progress" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: sleepFn,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "merge-task", taskId: TASK_ID, now: NOW },
    });

    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(continueTaskService.run).not.toHaveBeenCalled();
  });

  it("max-attempts cap — task pre-seeded with 1 ci-report; no GitHub calls", async () => {
    const repo = makeRepo();
    const existingReport: Artifact = {
      kind: "ci-report",
      ref: JSON.stringify({ prNumber: 1, failed: [] }),
      producedBy: "ci-babysitter",
      createdAt: NOW,
    };
    await makeTaskUpToFinalizing(repo, [existingReport]);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn();
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo, [existingReport]);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(listCheckRuns).not.toHaveBeenCalled();
    expect(continueTaskService.run).not.toHaveBeenCalled();
  });

  it("no checks bail — listCheckRuns empty for > noChecksBailMs; service returns silently", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();

    const shortBailCadence = {
      intervals: [{ afterMs: 0, everyMs: 1 }],
      maxHorizonMs: 10 * 60_000,
      noChecksBailMs: 0,
      confirmationDelayMs: 1,
    };

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: shortBailCadence,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(continueTaskService.run).not.toHaveBeenCalled();
  });

  it("engine-wide abort — signal cascades, pollPR stops", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);

    const ctrl = new AbortController();
    const sleepFn = vi.fn().mockImplementation((_ms: number, signal: AbortSignal) => {
      return abortingSleep(999_999, signal);
    });
    const listCheckRuns = vi.fn();
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: sleepFn,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setImmediate(r));

    ctrl.abort();
    await new Promise((r) => setTimeout(r, 50));

    expect(continueTaskService.run).not.toHaveBeenCalled();
  });

  it("pr ref parse failure — malformed URL; log + return without GitHub calls", async () => {
    const repo = makeRepo();
    const wf = createSingleTaskWorkflow(WORKFLOW_ID, { title: "T", prompt: "P" }, now);
    await repo.save(wf, []);
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
    });
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
    });

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn();
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const { sink, records } = makeCapturingSink();
    const log = createLogger("debug", [sink]);

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log,
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    const malformedPr: Artifact = {
      kind: "pr",
      ref: "https://github.com/acme/app/malformed-no-pull-number",
      producedBy: "merge-service",
      createdAt: NOW,
    };
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "open-review", taskId: TASK_ID, artifacts: [malformedPr], now: NOW },
    });

    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(listCheckRuns).not.toHaveBeenCalled();
    expect(continueTaskService.run).not.toHaveBeenCalled();
    const parseErrorRecord = records.find((r) => r.lvl === "error" && typeof r.msg === "string" && r.msg.includes("parse PR number"));
    expect(parseErrorRecord).toBeDefined();
  });

  it("attach polls existing pr-open tasks at attach time", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);
    await openPR(repo);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    // pollPR must have started without any task-transitioned event
    expect(listCheckRuns).toHaveBeenCalled();
  });

  it("pollPR bails on 404 from listCheckRuns", async () => {
    const repo = makeRepo();
    await makeTaskUpToFinalizing(repo);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockRejectedValue(
      new GitHubApiError(404, "https://api.github.com/repos/acme/app/commits/abc123/check-runs", "Not Found"),
    );
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const { sink, records } = makeCapturingSink();
    const log = createLogger("debug", [sink]);

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log,
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(continueTaskService.run).not.toHaveBeenCalled();
    const bailRecord = records.find((r) => r.lvl === "info" && typeof r.msg === "string" && r.msg.includes("force-pushed"));
    expect(bailRecord).toBeDefined();
  });
});

import { MergeConflictError, MergeService, MergeServiceError } from "../../src/application/merge-service.js";
import { createWorkflow } from "../../src/domain/workflow.js";

function makeMergeService(overrides: Partial<MergeService> = {}): MergeService {
  return {
    openOnly: vi.fn().mockResolvedValue({ workflow: null, events: [] } as unknown as CommandResult),
    merge: vi.fn().mockResolvedValue({ workflow: null, events: [] } as unknown as CommandResult),
    ...overrides,
  } as unknown as MergeService;
}

async function makeWorkflowWithAutoMergeOnGreen(repo: InMemoryWorkflowRepository, autoMergeOnGreen: boolean) {
  const wf = createWorkflow({
    id: WORKFLOW_ID,
    kind: "single-task",
    tasks: [{ id: TASK_ID, title: "T", prompt: "P" }],
    policy: { maxConcurrent: 1, autoLand: true, autoMergeOnGreen },
  }, now);
  await repo.save(wf, []);
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-ready", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "mark-running", taskId: TASK_ID, sessionId: "s1", now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "complete-runtime", taskId: TASK_ID, now: NOW },
  });
  await applyCommand(repo, {
    kind: "transition-task",
    workflowId: WORKFLOW_ID,
    transition: { kind: "start-finalization", taskId: TASK_ID, now: NOW },
  });
}

describe("CIBabysitterService autoMerge", () => {
  it("green CI + autoMergeOnGreen:false → no-op", async () => {
    const repo = makeRepo();
    await makeWorkflowWithAutoMergeOnGreen(repo, false);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const mergeService = makeMergeService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      mergeService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(mergeService.merge).not.toHaveBeenCalled();
  });

  it("green CI + autoMergeOnGreen:true → calls mergeService.merge", async () => {
    const repo = makeRepo();
    await makeWorkflowWithAutoMergeOnGreen(repo, true);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const mergeService = makeMergeService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      mergeService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(mergeService.merge).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WORKFLOW_ID, taskId: TASK_ID }));
  });

  it("green CI + autoMergeOnGreen:true + MergeConflictError → bail", async () => {
    const repo = makeRepo();
    await makeWorkflowWithAutoMergeOnGreen(repo, true);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const mergeService = makeMergeService({
      merge: vi.fn().mockRejectedValue(new MergeConflictError("rebase_conflict", "conflict")),
    });

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      mergeService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(mergeService.merge).toHaveBeenCalledOnce();
    expect(continueTaskService.run).not.toHaveBeenCalled();
  });

  it("green CI + autoMergeOnGreen:true + MergeServiceError → log + bail", async () => {
    const repo = makeRepo();
    await makeWorkflowWithAutoMergeOnGreen(repo, true);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const mergeService = makeMergeService({
      merge: vi.fn().mockRejectedValue(new MergeServiceError("merge_state_inconsistent", {})),
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      mergeService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    consoleSpy.mockRestore();

    expect(mergeService.merge).toHaveBeenCalledOnce();
  });

  it("green CI + autoMergeOnGreen:true + transient error → log + bail", async () => {
    const repo = makeRepo();
    await makeWorkflowWithAutoMergeOnGreen(repo, true);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const mergeService = makeMergeService({
      merge: vi.fn().mockRejectedValue(new Error("network timeout")),
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      mergeService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    consoleSpy.mockRestore();

    expect(mergeService.merge).toHaveBeenCalledOnce();
  });

  it("green CI + autoMergeOnGreen:true + task no longer pr-open after re-read → bail", async () => {
    const repo = makeRepo();
    await makeWorkflowWithAutoMergeOnGreen(repo, true);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();
    const mergeService = makeMergeService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      mergeService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);

    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "merge-task", taskId: TASK_ID, now: NOW },
    });

    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(mergeService.merge).not.toHaveBeenCalled();
  });

  it("mergeService omitted from deps + autoMergeOnGreen:true → no-op", async () => {
    const repo = makeRepo();
    await makeWorkflowWithAutoMergeOnGreen(repo, true);

    const ctrl = new AbortController();
    const listCheckRuns = vi.fn().mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" } satisfies GhCheckRun,
    ]);
    const github = makeGithub({ listCheckRuns });
    const continueTaskService = makeContinueTaskService();

    const service = new CIBabysitterService({
      workflowRepo: repo,
      github,
      repoCoords: { owner: OWNER, repo: REPO },
      applyCommand: (cmd) => applyCommand(repo, cmd),
      continueTaskService,
      signal: ctrl.signal,
      now,
      sleep: immediateSleep,
      cadence: FAST_CADENCE,
      log: silentLogger(),
    });

    service.attach(WORKFLOW_ID);
    await new Promise((r) => setImmediate(r));

    await openPR(repo);
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();

    expect(continueTaskService.run).not.toHaveBeenCalled();
  });
});
