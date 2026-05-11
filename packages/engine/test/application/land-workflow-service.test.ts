import { describe, expect, it, vi } from "vitest";
import { LandWorkflowService } from "../../src/application/land-workflow-service.js";
import { MergeService } from "../../src/application/merge-service.js";
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createWorkflow } from "../../src/domain/workflow.js";
import { transitionTask } from "../../src/application/transitions.js";
import type { Workflow } from "../../src/domain/types.js";
import type { MergeOutcome, MergeResult, SCMPlugin } from "../../src/plugins/scm-plugin.js";
import type { WorkspaceBackend, WorkspaceHandle } from "../../src/plugins/workspace-backend.js";
import { silentLogger } from "../test-helpers.js";

const NOW = "2026-05-10T00:00:00.000Z";
const now = () => NOW;
const WORKFLOW_ID = "wf-land";

function makeHandle(branch: string): WorkspaceHandle {
  return { workspaceId: `ws-${branch}`, mode: "worktree", path: `/tmp/${branch}`, containerPath: `/tmp/${branch}`, branch };
}

function makeWorkspace(): WorkspaceBackend {
  return {
    create: vi.fn().mockImplementation((spec: { branch: string }) =>
      Promise.resolve(makeHandle(spec.branch)),
    ),
    get: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

interface ScmCallTracker {
  rebaseCalls: string[];
  mergeCalls: number[];
}

function makeScm(
  tracker: ScmCallTracker,
  overrides: Partial<{
    rebaseImpl: (path: string, onto: string) => Promise<MergeResult>;
  }> = {},
): SCMPlugin {
  let prCounter = 100;
  return {
    createBranch: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue("abc"),
    squashCommits: vi.fn().mockResolvedValue("abc"),
    rebase: vi.fn().mockImplementation(async (path: string, onto: string) => {
      tracker.rebaseCalls.push(path);
      if (overrides.rebaseImpl) return overrides.rebaseImpl(path, onto);
      return { kind: "clean" } satisfies MergeResult;
    }),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    summarizeBranch: vi.fn().mockResolvedValue({ title: "test", commitBody: "", diffStat: "", commitCount: 1 }),
    openPullRequest: vi.fn(),
    findPullRequest: vi.fn().mockImplementation(async () => {
      const n = prCounter++;
      return { number: n, url: `https://github.com/o/r/pull/${n}`, headRef: "x", baseRef: "main" };
    }),
    getPullRequest: vi.fn().mockImplementation(async (input: { number: number }) => ({
      number: input.number,
      url: `https://github.com/o/r/pull/${input.number}`,
      headSha: `sha-${input.number}`,
      headRef: "x",
      baseRef: "main",
      mergeable: true,
      mergeableState: "clean",
      merged: false,
    })),
    mergePullRequest: vi.fn().mockImplementation(async (input: { number: number }) => {
      tracker.mergeCalls.push(input.number);
      return { merged: true, sha: `merged-${input.number}` } satisfies MergeOutcome;
    }),
  };
}

async function buildChainWorkflow(): Promise<InMemoryWorkflowRepository> {
  const repo = new InMemoryWorkflowRepository();
  let wf: Workflow = createWorkflow(
    {
      id: WORKFLOW_ID,
      kind: "manual-dag",
      tasks: [
        { id: "A", title: "A", prompt: "do A" },
        { id: "B", title: "B", prompt: "do B", dependsOn: ["A"] },
        { id: "C", title: "C", prompt: "do C", dependsOn: ["B"] },
      ],
      policy: { maxConcurrent: 3 },
    },
    now,
  );

  for (const taskId of ["A", "B", "C"]) {
    wf = transitionTask(wf, { kind: "mark-ready", taskId, now: NOW });
    wf = transitionTask(wf, { kind: "mark-running", taskId, sessionId: `s-${taskId}`, now: NOW });
    wf = transitionTask(wf, { kind: "complete-runtime", taskId, now: NOW });
    wf = transitionTask(wf, { kind: "start-finalization", taskId, now: NOW });
    wf = transitionTask(wf, {
      kind: "open-review",
      taskId,
      artifacts: [{ kind: "pr", ref: `https://example/pr/${taskId}`, producedBy: "test", createdAt: NOW }],
      now: NOW,
    });
  }

  await repo.save(wf, []);
  return repo;
}

function makeLandService(
  repo: InMemoryWorkflowRepository,
  scm: SCMPlugin,
  workspace: WorkspaceBackend,
): LandWorkflowService {
  const mergeService = new MergeService({
    repo,
    applyCommand: (cmd) => applyCommand(repo, cmd),
    scm,
    workspace,
    repoCoords: { owner: "o", repo: "r" },
    baseBranch: "main",
    now,
    log: silentLogger(),
  });
  return new LandWorkflowService({
    repo,
    mergeService,
    log: silentLogger(),
  });
}

describe("LandWorkflowService", () => {
  it("3-node chain A→B→C: lands in topological order, each child rebased before merge", async () => {
    const repo = await buildChainWorkflow();
    const tracker: ScmCallTracker = { rebaseCalls: [], mergeCalls: [] };
    const scm = makeScm(tracker);
    const workspace = makeWorkspace();
    const svc = makeLandService(repo, scm, workspace);

    const result = await svc.run({ workflowId: WORKFLOW_ID });

    expect(result.attempted).toEqual(["A", "B", "C"]);
    expect(result.merged).toEqual(["A", "B", "C"]);
    expect(result.skipped).toEqual([]);
    expect(result.conflicted).toBeUndefined();

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph["A"]?.executionStatus).toBe("merged");
    expect(wf?.graph["B"]?.executionStatus).toBe("merged");
    expect(wf?.graph["C"]?.executionStatus).toBe("merged");

    // each task got rebased once before its merge
    expect(tracker.rebaseCalls).toHaveLength(3);
    // and each task hit the PR merge API
    expect(tracker.mergeCalls).toHaveLength(3);
  });

  it("conflict on child B halts the cascade: A merged, B needs-review, C untouched at pr-open", async () => {
    const repo = await buildChainWorkflow();
    const tracker: ScmCallTracker = { rebaseCalls: [], mergeCalls: [] };
    const scm = makeScm(tracker, {
      rebaseImpl: async (path: string) => {
        if (path.includes("_B")) {
          return { kind: "conflict", conflictPaths: ["src/conflict.ts"] } satisfies MergeResult;
        }
        return { kind: "clean" } satisfies MergeResult;
      },
    });
    const workspace = makeWorkspace();
    const svc = makeLandService(repo, scm, workspace);

    const result = await svc.run({ workflowId: WORKFLOW_ID });

    expect(result.attempted).toEqual(["A", "B"]);
    expect(result.merged).toEqual(["A"]);
    expect(result.conflicted).toBe("B");
    expect(result.skipped).toEqual(["C"]);

    const wf = await repo.get(WORKFLOW_ID);
    expect(wf?.graph["A"]?.executionStatus).toBe("merged");
    expect(wf?.graph["B"]?.executionStatus).toBe("needs-review");
    expect(wf?.graph["C"]?.executionStatus).toBe("pr-open");

    // C never got rebased or merged
    expect(tracker.rebaseCalls.every((p) => !p.includes("_C"))).toBe(true);
    expect(tracker.mergeCalls).toHaveLength(1);

    // B got a conflict artifact
    const bArtifacts = wf?.graph["B"]?.artifacts ?? [];
    const patch = bArtifacts.find((a) => a.kind === "patch");
    expect(patch).toBeDefined();
    const parsed = JSON.parse(patch!.ref) as { phase: string; conflictPaths: string[] };
    expect(parsed.phase).toBe("rebase");
    expect(parsed.conflictPaths).toEqual(["src/conflict.ts"]);
  });

  it("returns 404 when workflow does not exist", async () => {
    const repo = new InMemoryWorkflowRepository();
    const tracker: ScmCallTracker = { rebaseCalls: [], mergeCalls: [] };
    const svc = makeLandService(repo, makeScm(tracker), makeWorkspace());

    await expect(svc.run({ workflowId: "missing" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("ignores tasks not in pr-open: only attempts merging the pr-open ones", async () => {
    const repo = await buildChainWorkflow();
    // mark C as merged ahead of time (simulate already landed)
    await applyCommand(repo, {
      kind: "transition-task",
      workflowId: WORKFLOW_ID,
      transition: { kind: "merge-task", taskId: "C", now: NOW },
    });

    const tracker: ScmCallTracker = { rebaseCalls: [], mergeCalls: [] };
    const svc = makeLandService(repo, makeScm(tracker), makeWorkspace());

    const result = await svc.run({ workflowId: WORKFLOW_ID });
    expect(result.attempted).toEqual(["A", "B"]);
    expect(result.merged).toEqual(["A", "B"]);
    expect(result.skipped).toEqual([]);
  });
});
