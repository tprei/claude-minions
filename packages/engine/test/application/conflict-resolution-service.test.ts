import { describe, expect, it, vi } from "vitest";
import { ConflictResolutionService } from "../../src/application/conflict-resolution-service.js";
import { applyCommand } from "../../src/application/commands.js";
import { InMemoryWorkflowRepository } from "../../src/application/repository.js";
import { createSingleTaskWorkflow } from "../../src/domain/workflow.js";
import { StubProviderPlugin } from "../../src/plugins/providers/stub.js";
import { silentLogger } from "../test-helpers.js";
import type { ProviderEvent } from "../../src/plugins/provider-plugin.js";
import type { RuntimeAttachOptions, RuntimeBackend, RuntimeOutputChunk } from "../../src/plugins/runtime-backend.js";
import type { RuntimeProbeState } from "../../src/application/recovery.js";
import type { GitClient } from "../../src/plugins/git/git-client.js";
import type { SCMPlugin } from "../../src/plugins/scm-plugin.js";
import type { QualityPlugin } from "../../src/plugins/quality-plugin.js";
import type { ConflictResolutionRequest } from "../../src/plugins/conflict-resolver.js";

const now = "2026-05-22T10:00:00.000Z";
const WF = "wf-1";
const TASK = "wf-1:task";

async function prOpenRepo(): Promise<InMemoryWorkflowRepository> {
  const repo = new InMemoryWorkflowRepository();
  const wf = createSingleTaskWorkflow(WF, { title: "T", prompt: "P" }, () => now);
  const task = wf.graph[TASK]!;
  await repo.save({ ...wf, graph: { [TASK]: { ...task, executionStatus: "pr-open" } } }, []);
  return repo;
}

function chunk(text: string): RuntimeOutputChunk {
  return { sessionId: "s1", offset: 0, bytes: new TextEncoder().encode(text) };
}

function makeRuntime(chunks: RuntimeOutputChunk[]): RuntimeBackend {
  return {
    start: async () => ({ sessionId: "s1", runtimeType: "stub" }),
    stop: async () => {},
    probe: async () => "live" as RuntimeProbeState,
    attach: (_s: string, _o?: RuntimeAttachOptions) => ({
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c;
      },
    }),
  };
}

function makeGit(overrides: Partial<Record<keyof GitClient, unknown>> = {}): GitClient {
  return {
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    hasConflictMarkers: vi.fn().mockResolvedValue(false),
    statusIsClean: vi.fn().mockResolvedValue(true),
    rebaseContinue: vi.fn().mockResolvedValue({ kind: "clean" }),
    rebaseAbort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitClient;
}

function makeQuality(status: "passed" | "failed" | "partial"): QualityPlugin {
  return {
    loadConfig: vi.fn().mockResolvedValue([{ name: "build", checks: [] }]),
    run: vi.fn().mockResolvedValue({ status, checks: [] }),
  } as unknown as QualityPlugin;
}

function request(): ConflictResolutionRequest {
  return { workflowId: WF, taskId: TASK, workspacePath: "/tmp/ws", branch: "b", baseBranch: "main", conflictPaths: ["f.ts"] };
}

const finalFrame: ProviderEvent = { kind: "final", sessionRef: "s" };

function makeService(repo: InMemoryWorkflowRepository, opts: {
  git?: GitClient;
  quality?: QualityPlugin;
  scmPush?: ReturnType<typeof vi.fn>;
  frames?: ProviderEvent[][];
  chunks?: RuntimeOutputChunk[];
}) {
  const scmPush = opts.scmPush ?? vi.fn().mockResolvedValue(undefined);
  const scm = { pushBranch: scmPush } as unknown as SCMPlugin;
  const provider = new StubProviderPlugin({ frames: opts.frames ?? [[finalFrame]] });
  const runtime = makeRuntime(opts.chunks ?? [chunk("line\n")]);
  const deps = {
    repo,
    applyCommand: (cmd: Parameters<typeof applyCommand>[1]) => applyCommand(repo, cmd),
    providerFactory: () => provider,
    runtime,
    scm,
    git: opts.git ?? makeGit(),
    now: () => now,
    log: silentLogger(),
    ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
  };
  return { service: new ConflictResolutionService(deps), scmPush, deps };
}

describe("ConflictResolutionService", () => {
  it("resolved + build passed → resolved, branch pushed, task back to pr-open", async () => {
    const repo = await prOpenRepo();
    const { service, scmPush } = makeService(repo, { quality: makeQuality("passed") });

    const outcome = await service.resolve(request());

    expect(outcome.kind).toBe("resolved");
    expect(scmPush).toHaveBeenCalledOnce();
    expect((await repo.get(WF))!.graph[TASK]!.executionStatus).toBe("pr-open");
  });

  it("conflict markers remain → unresolved, rebase aborted, task needs-review with attempted artifact", async () => {
    const repo = await prOpenRepo();
    const git = makeGit({ hasConflictMarkers: vi.fn().mockResolvedValue(true) });
    const { service, scmPush } = makeService(repo, { git, quality: makeQuality("passed") });

    const outcome = await service.resolve(request());

    expect(outcome.kind).toBe("unresolved");
    expect(git.rebaseAbort).toHaveBeenCalled();
    expect(scmPush).not.toHaveBeenCalled();
    const task = (await repo.get(WF))!.graph[TASK]!;
    expect(task.executionStatus).toBe("needs-review");
    const conflictArtifact = task.artifacts.find((a) => a.kind === "conflict");
    expect(conflictArtifact).toBeDefined();
    expect(JSON.parse(conflictArtifact!.ref).attempted).toBe(true);
  });

  it("build verification fails → unresolved → needs-review", async () => {
    const repo = await prOpenRepo();
    const { service, scmPush } = makeService(repo, { quality: makeQuality("failed") });

    const outcome = await service.resolve(request());

    expect(outcome.kind).toBe("unresolved");
    expect(scmPush).not.toHaveBeenCalled();
    expect((await repo.get(WF))!.graph[TASK]!.executionStatus).toBe("needs-review");
  });

  it("build verification partial → unresolved → needs-review", async () => {
    const repo = await prOpenRepo();
    const { service } = makeService(repo, { quality: makeQuality("partial") });
    const outcome = await service.resolve(request());
    expect(outcome.kind).toBe("unresolved");
    expect((await repo.get(WF))!.graph[TASK]!.executionStatus).toBe("needs-review");
  });

  it("agent ends without final → unresolved", async () => {
    const repo = await prOpenRepo();
    const { service } = makeService(repo, {
      quality: makeQuality("passed"),
      frames: [[{ kind: "assistant_text", text: "hi" }]],
    });
    const outcome = await service.resolve(request());
    expect(outcome.kind).toBe("unresolved");
  });

  it("no quality plugin → resolved without build verification", async () => {
    const repo = await prOpenRepo();
    const { service, scmPush } = makeService(repo, {});

    const outcome = await service.resolve(request());

    expect(outcome.kind).toBe("resolved");
    expect(scmPush).toHaveBeenCalledOnce();
  });

  it("agent staged but did not continue → rebaseContinue recovers, resolved", async () => {
    const repo = await prOpenRepo();
    const isRebaseInProgress = vi.fn()
      .mockResolvedValueOnce(true)   // before continue
      .mockResolvedValueOnce(false); // after continue
    const git = makeGit({ isRebaseInProgress });
    const { service } = makeService(repo, { git, quality: makeQuality("passed") });

    const outcome = await service.resolve(request());

    expect(outcome.kind).toBe("resolved");
    expect(git.rebaseContinue).toHaveBeenCalledOnce();
  });
});
