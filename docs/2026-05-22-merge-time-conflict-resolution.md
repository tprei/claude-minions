# Merge-time conflict resolution

Date: 2026-05-22
Status: design (not implemented)
Scope: `packages/engine`

## Problem

Workflows build a DAG of tasks; each task opens a PR. At land time, `LandWorkflowService.run` orders pr-open tasks topologically and calls `MergeService.merge()` per task. Inside `merge`, `runUntilOpen` rebases the task branch onto the base branch before squash-merging. When two PRs touch the same lines — true stacks (A→B→C) or parallel siblings off the same parent that edit the same file — the rebase conflicts.

Today that path is terminal: `scm.rebase` returns `{ kind: "conflict" }`, `runUntilOpen` throws `MergeConflictError("rebase_conflict", ...)`, `handlePhaseError` applies the `merge-conflict` transition (pr-open|finalizing → needs-review) with a conflict patch artifact, and `LandWorkflowService` halts the cascade on the first needs-review task.

We want the engine to resolve these conflicts automatically: when a rebase conflicts during land, spawn an agent in the worktree to resolve the conflict markers, continue the rebase, verify the build, push the resolved branch, then proceed with the merge. Fall back to needs-review only when the agent genuinely cannot resolve.

## Verification of current code

Confirmed against the tree (read, not assumed):

- `application/land-workflow-service.ts` — `run` topologically orders pr-open tasks, calls `mergeService.merge()` per task, halts when a task ends in `needs-review`, returns `{ attempted, merged, skipped, conflicted }`.
- `application/merge-service.ts` — `runUntilOpen` calls `scm.rebase(workspaceHandle.path, baseBranch)`; on `conflict` throws `MergeConflictError("rebase_conflict", …, conflictPaths)`. `handlePhaseError` maps `MergeConflictError` to the `merge-conflict` transition. `merge()` cleans up the workspace handle in a `finally`. Phase events are emitted through `emitPhase(workflowId, taskId, phase, status, error?)` as transient `merge-phase` events.
- `plugins/github/github-scm-plugin.ts` — `rebase` runs `git rebase onto`; on `CONFLICT` it reads `git diff --name-only --diff-filter=U`, then **`git rebase --abort`** and returns the conflict. So the working tree is **clean** (rebase aborted) by the time `MergeService` sees the conflict. This is load-bearing for the design below.
- `application/run-orchestrator.ts` + `plugins/providers/run-provider.ts` — `runProvider(runtime, sessionId, provider, opts)` is the async-iterator agent primitive ending in a `final` event. `RunOrchestrator.run()` consumes it but dispatches task lifecycle transitions (mark-interrupted, complete-runtime, recover-task) and is built for the **async** fire-and-forget spawn path. It is not reusable for a synchronous resolve-and-return call.
- `application/retry-task-service.ts` — the spawn pattern: `provider.prepare()` → `runtime.start({ command, workspacePath })` → `spawnOrchestrator(...)` (fire-and-forget via `RunOrchestrator`). Async, not awaitable to completion.
- `application/transitions.ts` + `domain/types.ts` — explicit state machine. `TASK_EXECUTION_STATUSES`, `TRANSITION_KINDS`, each rule `{ from[], apply }`. `merge-conflict` is the existing terminal-to-needs-review transition.
- `plugins/git/git-client.ts` — has `run`, `worktree*`, `revParse`, `branchExists`. **No** `rebase --continue`, conflict-file listing, staging, or abort helpers.
- `plugins/scm-plugin.ts` — `rebase` returns `MergeResult` (`clean | conflict`) and aborts internally. No "rebase, leave conflict in tree" mode, no continue/abort surface.
- `plugins/workspace/git-worktree-backend.ts` + `workspace-backend.ts` — `create({ …, baseRef, resetBranch })`, `get`, `cleanup`. `MergeService` reuses an existing workspace via `workspace.get(workspaceId)` keyed `ws-${slug(wf)}_${slug(task)}`.
- `plugins/quality-plugin.ts` + `plugins/quality/exec-quality-plugin.ts` — `loadConfig(workspacePath)` reads `.minions/quality.json`; `run(configs, workspacePath, opts)` returns `{ status: passed|failed|partial, checks }`. Config-driven build/typecheck commands already exist and are the natural build-verification surface.
- `engine.ts` — wires `MergeService` and `LandWorkflowService`. `providerFactory`, `runtime`, `workspace`, `repoRegistry`, `now`, `log` are all in scope where `MergeService` is constructed.

## Key decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Where to hook | Inside `MergeService`'s rebase path, behind a new `ConflictResolver` collaborator. `LandWorkflowService` stays unchanged in shape; the cascade naturally continues because resolved tasks reach `merged`. |
| 2 | Sync vs async agent run | New synchronous primitive `runProviderToCompletion` (thin awaitable wrapper over `runProvider`) and a new `ConflictResolutionService` that owns the resolve loop. The fire-and-forget `RunOrchestrator` is **not** reused — its lifecycle transitions are wrong for an inline sub-run. |
| 3 | State model | Add one execution status `resolving-conflict` and three transitions (`start-conflict-resolution`, `complete-conflict-resolution`, `fail-conflict-resolution`) for observability and crash recovery. Resolution is not "internal to the merge call". |
| 4 | Resolution agent contract | Work against a **live conflicted rebase** (markers in tree), not a clean re-apply. Requires a non-aborting rebase entry point. Success = rebase completed + no conflict markers + `git status` clean + build verification passes. Build verification reuses the quality plugin. |
| 5 | Idempotency & loops | Hard cap of 1 resolution attempt per task per land pass (configurable, default 1). On cap or any failure: abort the rebase, fall back to the existing `merge-conflict` transition with the conflict artifact. No re-entry into resolution. |
| 6 | git-client additions | Add `rebaseStart` (no auto-abort), `listConflictedFiles`, `hasConflictMarkers`, `addAll`, `rebaseContinue`, `rebaseAbort`, `isRebaseInProgress`, `statusIsClean`. |
| 7 | Multi-conflict cascades | Per-task by construction: each task rebases onto the freshly-updated base, and each invokes the resolver independently. No special cascade logic. |

## Chosen architecture

### Overview

Introduce a `ConflictResolver` port and a `ConflictResolutionService` implementation. `MergeService` gains an optional `conflictResolver` dependency. The rebase step in `runUntilOpen` changes from a one-shot `scm.rebase` to:

1. Attempt rebase via a **non-aborting** entry point (`scm.rebaseLeaveConflicts`).
2. On `clean` → unchanged (push + continue).
3. On `conflict` and a resolver is configured and the task is eligible → call `conflictResolver.resolve(...)`.
   - `resolved` → push the resolved branch, continue to PR/merge.
   - `unresolved` → abort the rebase, throw `MergeConflictError` (existing fallback path).
4. On `conflict` with no resolver → abort the rebase, throw `MergeConflictError` (today's behavior, preserved).

The resolution run is synchronous within the land HTTP call (land already blocks the POST). The resolver owns: state transition into `resolving-conflict`, building the prompt, spawning the agent against the live conflicted tree, awaiting completion, verifying success (no markers + rebase continued + build green), and transitioning out.

### Why hook in MergeService, not LandWorkflowService

The conflict is detected, and the worktree exists, only inside `runUntilOpen`. `LandWorkflowService` has no worktree handle and no rebase context — hooking there would require re-deriving and re-creating the worktree and re-running the rebase, duplicating `MergeService` internals. Hooking in `MergeService` keeps the worktree, base branch, branch name, and signal in one place. `LandWorkflowService` needs no change to its control flow: a resolved task simply reaches `merged` and the loop proceeds; an unresolved task reaches `needs-review` and the loop halts exactly as today. `CIBabysitterService` and `CompletionDispatcher`, which also call `mergeService.merge()`, transparently gain resolution too.

### Why a synchronous primitive, not RunOrchestrator

`RunOrchestrator.run()` is built for the detached lifecycle: it dispatches `complete-runtime` / `mark-interrupted` / `recover-task` against the **task's** session and cleans up the workspace on completion. A conflict-resolution sub-run must not touch the task's main run lifecycle, must not clean up the worktree (the merge still needs it), and must return a structured outcome to its caller. Reusing `RunOrchestrator` would mean fighting its transitions. Instead, add a minimal awaitable consumer over the existing `runProvider` iterator and let `ConflictResolutionService` own the (separate, resolution-scoped) lifecycle transitions.

## State and transition changes

### New execution status

`domain/types.ts`:

```ts
export const TASK_EXECUTION_STATUSES = [
  "pending", "ready", "running", "completed", "finalizing",
  "quality-pending", "ci-pending", "pr-open",
  "resolving-conflict",            // NEW
  "merged", "failed", "cancelled", "needs-review",
] as const;
```

Set membership updates in `domain/types.ts`:

- `TASK_CLAIM_HOLDING_STATUSES` — add `resolving-conflict` (the task still owns its claims while an agent edits the worktree).
- Do **not** add to `TASK_AGENT_OCCUPYING_STATUSES` — land runs serially and is not subject to `policy.maxConcurrent`; counting it would distort the scheduler.
- Do **not** add to `TASK_TERMINAL_*` / `TASK_WORKFLOW_COMPLETING_STATUSES` — it is transient.

### New transitions

`application/transitions.ts` — add to `TRANSITION_KINDS` and `TRANSITIONS`:

```ts
"start-conflict-resolution": {
  from: ["pr-open", "finalizing"],
  apply: () => ({ patch: { executionStatus: "resolving-conflict" } }),
},
"complete-conflict-resolution": {
  from: ["resolving-conflict"],
  apply: () => ({ patch: { executionStatus: "pr-open" } }),
},
"fail-conflict-resolution": {
  from: ["resolving-conflict"],
  apply: (task, command) => ({
    patch: {
      executionStatus: "needs-review",
      artifacts: appendArtifacts(task, command),
    },
  }),
},
```

Rationale:

- `start-conflict-resolution` accepts both `pr-open` (land of an already-open PR) and `finalizing` (first-time open during land), mirroring `runUntilOpen`'s precondition that the task is in one of those two states.
- `complete-conflict-resolution` returns to `pr-open` so the merge can proceed through the existing `merge-task` (`from: ["pr-open"]`) path. If resolution happened while the task was `finalizing` (no PR yet), the PR open still runs after rebase in `runUntilOpen`; the resolver completes back to `pr-open` only after `runUntilOpen` has reached the open-review step. See "Sequencing" below for the exact ordering.
- `fail-conflict-resolution` carries the conflict artifact and lands the task in `needs-review`, the same terminal as `merge-conflict`. It is distinct from `merge-conflict` so the artifact can record that an automated attempt was made and failed (for observability and to prevent a second attempt on retry).

### Sequencing inside runUntilOpen

The resolver must run **after** the rebase conflict is detected but **before** the PR is opened/found, because the resolution mutates the branch HEAD. The cleanest sequencing keeps the transition pair tight:

1. `start-conflict-resolution` (pr-open|finalizing → resolving-conflict) — emitted by the resolver when it begins.
2. Agent resolves; rebase continues; build verified; branch pushed.
3. `complete-conflict-resolution` (resolving-conflict → pr-open) — but only valid coming *from* `resolving-conflict`. Since `runUntilOpen` for a `finalizing` task expects to open the PR while still `finalizing`, the resolver must restore the pre-resolution status, not force `pr-open`.

To avoid coupling the resolver to the open-PR step, the resolver records the **entry status** and restores it:

```ts
"complete-conflict-resolution": {
  from: ["resolving-conflict"],
  apply: (task, command) => ({
    patch: { executionStatus: command.reason === "finalizing" ? "finalizing" : "pr-open" },
  }),
},
```

The resolver passes the captured entry status via `command.reason`. This keeps `runUntilOpen` linear: rebase (with resolution) → push → open-or-find PR → merge, with the task back in its original status by the time the PR step runs.

## New and changed files

### New: `plugins/conflict-resolver.ts` (port)

```ts
import type { Artifact } from "../domain/types.js";

export interface ConflictResolutionRequest {
  workflowId: string;
  taskId: string;
  workspacePath: string;      // host path of the worktree mid-rebase
  branch: string;
  baseBranch: string;
  conflictPaths: string[];
  entryStatus: "pr-open" | "finalizing";
  signal?: AbortSignal;
}

export type ConflictResolutionOutcome =
  | { kind: "resolved" }
  | { kind: "unresolved"; reason: string; artifact: Artifact };

export interface ConflictResolver {
  resolve(req: ConflictResolutionRequest): Promise<ConflictResolutionOutcome>;
}
```

### New: `plugins/providers/run-provider-sync.ts` (awaitable agent run)

```ts
import type { RuntimeBackend } from "../runtime-backend.js";
import type { ProviderEvent, ProviderPlugin } from "../provider-plugin.js";
import { runProvider, type RunProviderOptions } from "./run-provider.js";

export interface ProviderRunSummary {
  finalReceived: boolean;
  fatalError?: { source?: string; message: string };
  sessionRef?: string;
}

export async function runProviderToCompletion(
  runtime: RuntimeBackend,
  sessionId: string,
  provider: ProviderPlugin,
  opts: RunProviderOptions,
  onEvent?: (event: ProviderEvent) => void,
): Promise<ProviderRunSummary> {
  let finalReceived = false;
  let fatalError: { source?: string; message: string } | undefined;
  let sessionRef: string | undefined;

  for await (const item of runProvider(runtime, sessionId, provider, opts)) {
    if (item.kind === "offset") continue;
    const event = item.event;
    onEvent?.(event);
    if (event.kind === "error" && !event.recoverable) {
      fatalError = { message: event.message, ...(event.source !== undefined ? { source: event.source } : {}) };
      continue;
    }
    if (event.kind === "final") {
      finalReceived = true;
      sessionRef = event.sessionRef || undefined;
    }
  }

  const summary: ProviderRunSummary = { finalReceived };
  if (fatalError !== undefined) summary.fatalError = fatalError;
  if (sessionRef !== undefined) summary.sessionRef = sessionRef;
  return summary;
}
```

This is intentionally minimal: it consumes the iterator to completion and reports whether the run finished and whether it errored fatally. It does **not** dispatch any task transitions (the service does) and does **not** clean up the workspace.

### New: `application/conflict-resolution-service.ts` (the resolver implementation)

Dependencies (constructor):

```ts
export interface ConflictResolutionServiceDeps {
  repo: WorkflowRepository;
  applyCommand: (cmd: Command) => Promise<CommandResult>;
  providerFactory: () => ProviderPlugin;
  runtime: RuntimeBackend;
  scm: SCMPlugin;
  git: GitClient;                 // for rebase --continue / abort / status
  quality?: QualityPlugin;        // build verification; if absent, marker-only verification
  now: () => string;
  log: Logger;
  maxAttempts?: number;           // default 1
  qualityDefaultTimeoutMs?: number;
}
```

`resolve(req)` flow:

1. `start-conflict-resolution` transition (entryStatus → resolving-conflict).
2. Emit a `merge-phase` event `phase: "resolveConflict", status: "started"` (see "Observability" — the phase is added to the shared union).
3. Build the resolution prompt (see "Agent contract").
4. `provider = providerFactory()`; `invocation = await provider.prepare({ taskId, workflowId, prompt, dependencyArtifacts: [], workflowKind: workflow.kind })`.
5. `{ sessionId } = await runtime.start({ taskId, workflowId, command: invocation.command, workspacePath: <containerPath>, env })`.
6. `summary = await runProviderToCompletion(runtime, sessionId, provider, { signal }, publishProviderEvent)`.
7. Verify success (`verifyResolution`, below). On success:
   - `scm.pushBranch(workspacePath, branch)`.
   - `complete-conflict-resolution` transition (reason = entryStatus).
   - Emit `phase: "resolveConflict", status: "completed"`.
   - Return `{ kind: "resolved" }`.
8. On failure (markers remain, rebase not continued, build red, agent fatal-errored, or no `final`):
   - `git.rebaseAbort(workspacePath)` (best-effort).
   - Build conflict artifact `{ kind: "conflict", ref: JSON.stringify({ phase: "resolveConflict", reason, conflictPaths, attempted: true }) }`.
   - `fail-conflict-resolution` transition (artifacts: [artifact], reason).
   - Emit `phase: "resolveConflict", status: "completed", error: reason`.
   - Return `{ kind: "unresolved", reason, artifact }`.

`verifyResolution(workspacePath)`:

1. `if (await git.isRebaseInProgress(workspacePath))` → the agent staged files but did not continue: attempt `git.rebaseContinue` once; if it re-conflicts or fails, fail.
2. `if (await git.hasConflictMarkers(workspacePath))` → fail ("conflict markers remain").
3. `if (!(await git.statusIsClean(workspacePath)))` → fail ("worktree not clean after rebase").
4. Build verification:
   - `configs = await quality.loadConfig(workspacePath)` (if `quality` configured and `.minions/quality.json` exists).
   - `result = await quality.run(configs, workspacePath, { signal, defaultTimeoutMs })`.
   - `if (result.status === "failed")` → fail ("build verification failed: <failed check names>").
   - `partial` (non-required failures) → pass.
   - No configs → pass (marker-and-clean verification only; explicitly logged).

The attempt cap is enforced by `maxAttempts` and by the artifact marker `attempted: true`: `MergeService` checks for an existing `attempted: true` conflict artifact before invoking the resolver, so a re-land never re-runs resolution on a task that already failed it. This is the loop guard.

### Changed: `plugins/scm-plugin.ts`

Add a non-aborting rebase entry point so the conflicted tree survives for the agent:

```ts
export interface SCMPlugin {
  // ...existing...
  rebase(path: string, onto: string): Promise<MergeResult>;            // unchanged: aborts on conflict
  rebaseLeaveConflicts(path: string, onto: string): Promise<MergeResult>; // NEW: leaves conflict markers in tree
}
```

`rebase` keeps aborting (used by callers that want a clean no-op probe). `rebaseLeaveConflicts` is used only by `MergeService` when a resolver is configured. Splitting the two avoids changing the semantics of the existing `rebase` and avoids a boolean-flag parameter (explicit over implicit).

### Changed: `plugins/github/github-scm-plugin.ts`

Implement `rebaseLeaveConflicts`:

```ts
async rebaseLeaveConflicts(path: string, onto: string): Promise<MergeResult> {
  try {
    await this.git.run(path, ["rebase", onto]);
    return { kind: "clean" };
  } catch (err) {
    if (err instanceof GitError && /CONFLICT/i.test(err.stdout + err.stderr)) {
      const conflictPaths = await this.git.listConflictedFiles(path);
      return { kind: "conflict", conflictPaths };   // NO rebase --abort — leaves markers
    }
    throw err;
  }
}
```

### Changed: `plugins/git/git-client.ts`

Add the missing primitives (all thin wrappers over `run`):

```ts
async listConflictedFiles(path: string): Promise<string[]> {
  const { stdout } = await this.run(path, ["diff", "--name-only", "--diff-filter=U"]);
  return stdout.trim().split("\n").filter(Boolean);
}

async hasConflictMarkers(path: string): Promise<boolean> {
  // git grep returns exit 1 (no match) → false; exit 0 → true; treat other codes as error
  try {
    await this.run(path, ["grep", "-lE", "^(<<<<<<<|=======|>>>>>>>)", "--", "."]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return false;
    throw err;
  }
}

async addAll(path: string): Promise<void> {
  await this.run(path, ["add", "-A"]);
}

async rebaseContinue(path: string): Promise<MergeResult> {
  try {
    await this.run(path, ["-c", "core.editor=true", "rebase", "--continue"]);
    return { kind: "clean" };
  } catch (err) {
    if (err instanceof GitError && /CONFLICT/i.test(err.stdout + err.stderr)) {
      return { kind: "conflict", conflictPaths: await this.listConflictedFiles(path) };
    }
    throw err;
  }
}

async rebaseAbort(path: string): Promise<void> {
  await this.run(path, ["rebase", "--abort"]).catch(() => {});
}

async isRebaseInProgress(path: string): Promise<boolean> {
  const { stdout } = await this.run(path, ["rev-parse", "--git-path", "rebase-merge"]);
  // also check rebase-apply for non-merge rebases
  const mergeDir = stdout.trim();
  return (await this.pathExists(path, mergeDir)) || (await this.pathExists(path, ".git/rebase-apply"));
}

async statusIsClean(path: string): Promise<boolean> {
  const { stdout } = await this.run(path, ["status", "--porcelain"]);
  return stdout.trim().length === 0;
}
```

`MergeResult` import moves into `git-client.ts` from `scm-plugin.ts` (or `rebaseContinue` returns a local `{ kind }` shape). To avoid a cross-import from a plugin port into another plugin port, define the conflict shape inline in `git-client.ts` and have the SCM plugin adapt. `isRebaseInProgress` uses a small `pathExists` helper (fs `access` against the resolved git dir); `git rev-parse --git-path` resolves the worktree's real git dir, which for linked worktrees is under the main repo's `.git/worktrees/<name>`.

Note on the agent flow: the agent is instructed to stage and `git rebase --continue` itself. `verifyResolution` handles the case where it staged but forgot to continue (calls `rebaseContinue` once). The `addAll` helper exists for that recovery path. If the agent already completed the rebase, `isRebaseInProgress` is false and we skip straight to marker/clean/build checks.

### Changed: `application/merge-service.ts`

Add optional dependency and rewire the rebase step:

```ts
export interface MergeServiceDeps {
  // ...existing...
  conflictResolver?: ConflictResolver;
}
```

In `runUntilOpen`, replace the rebase block:

```ts
this.emitPhase(workflowId, taskId, "rebase", "started");
const useResolver = this.deps.conflictResolver !== undefined && !this.hasFailedResolution(task);
const rebaseResult = useResolver
  ? await this.deps.scm.rebaseLeaveConflicts(workspaceHandle.path, baseBranch)
  : await this.deps.scm.rebase(workspaceHandle.path, baseBranch);

if (rebaseResult.kind === "conflict") {
  if (!useResolver) {
    throw new MergeConflictError("rebase_conflict", `rebase conflict in ${rebaseResult.conflictPaths.join(", ")}`, rebaseResult.conflictPaths);
  }
  const outcome = await this.deps.conflictResolver!.resolve({
    workflowId, taskId,
    workspacePath: workspaceHandle.path,
    branch, baseBranch,
    conflictPaths: rebaseResult.conflictPaths,
    entryStatus: task.executionStatus as "pr-open" | "finalizing",
    ...(signal !== undefined ? { signal } : {}),
  });
  if (outcome.kind === "unresolved") {
    // resolver already aborted the rebase and applied fail-conflict-resolution → needs-review.
    // surface as MergeConflictError WITHOUT re-applying the transition.
    throw new ResolutionFailedError(outcome.reason, rebaseResult.conflictPaths);
  }
  // resolved: branch already pushed by the resolver; refresh task state and continue.
}
await scm.pushBranch(workspaceHandle.path, branch);
this.emitPhase(workflowId, taskId, "rebase", "completed");
```

Where:

- `hasFailedResolution(task)` returns true if `task.artifacts` contains a conflict artifact with `attempted: true` — the loop guard.
- `ResolutionFailedError` is a new sentinel so `handlePhaseError` knows the needs-review transition has **already** been applied by the resolver and must not be re-applied (which would throw `invalid_transition` from `needs-review`). `handlePhaseError` treats it like `MergeAbortedError`-adjacent: it returns the current workflow (`buildIdempotentResult`-style) so `merge()` returns a task in `needs-review` and `LandWorkflowService` halts normally.

`handlePhaseError` addition:

```ts
if (err instanceof ResolutionFailedError) {
  // resolver already transitioned to needs-review; do not re-apply.
  const wf = await repo.get(workflowId);
  if (!wf) throw err;
  return { workflow: wf, events: [] };
}
```

The pushed-by-resolver branch means `runUntilOpen` should **not** re-push before the PR step in the resolved case; the existing `scm.pushBranch` after the rebase block is idempotent (force-with-lease) so leaving it is safe, but the resolver's push already advanced the remote. Keep the single post-rebase push; it is a no-op fast-forward.

### Changed: `engine.ts`

Construct the `ConflictResolutionService` and pass it to `MergeService`, only when a `providerFactory` is configured (resolution needs an agent). Guard exactly like the other agent-dependent wiring:

```ts
let conflictResolver: ConflictResolver | undefined;
if (config.providerFactory && sharedGitClient !== undefined) {
  conflictResolver = new ConflictResolutionService({
    repo,
    applyCommand: (cmd) => applyCommand(repo, cmd),
    providerFactory: config.providerFactory,
    runtime,
    scm,
    git: sharedGitClient,
    ...(config.qualityPlugin !== undefined ? { quality: config.qualityPlugin } : {}),
    now,
    log: log.child({ component: "conflict-resolution" }),
    ...(config.qualityDefaultTimeoutMs !== undefined ? { qualityDefaultTimeoutMs: config.qualityDefaultTimeoutMs } : {}),
  });
}

serverDeps.mergeService = new MergeService({
  repo,
  applyCommand: (cmd) => applyCommand(repo, cmd),
  scm,
  workspace,
  repoRegistry,
  now,
  log: log.child({ component: "merge" }),
  ...(conflictResolver !== undefined ? { conflictResolver } : {}),
});
```

When no `providerFactory` exists (stub mode), `conflictResolver` is undefined and `MergeService` falls back to today's aborting `rebase` + needs-review. This is the legitimate "cannot resolve" path, not a workaround.

### Changed: `packages/shared/src/event.ts`

Add `resolveConflict` to the `MergePhase` union so the new phase event is typed and renders in the UI timeline:

```ts
export type MergePhase = "prepareMerge" | "commit" | "squash" | "rebase" | "applyMerge" | "finalize" | "resolveConflict";
```

## The agent resolution loop

### Working state

The agent runs against a **live conflicted rebase**: `git rebase` has stopped at a conflicting commit, conflict markers are in the working tree, `.git/rebase-merge` (or `rebase-apply`) exists. This is materially better than handing the agent a clean tree and asking it to re-apply: the agent sees exactly git's three-way markers and can resolve them in place, then `git rebase --continue` advances to the next conflicting commit (rebase can stop multiple times). A clean-tree re-apply would lose git's conflict context and force the agent to reconstruct the merge.

### Prompt

The prompt is built by `ConflictResolutionService` and passed through `provider.prepare`. Concrete content:

```
You are resolving a git rebase conflict inside a worktree. A rebase of branch
`<branch>` onto `<baseBranch>` stopped on conflicts.

Conflicting files:
<conflictPaths, one per line>

Do this:
1. Inspect each conflicting file. Resolve every conflict marker
   (<<<<<<<, =======, >>>>>>>) by integrating BOTH sides' intent. Do not
   discard either side's changes unless one is a strict superset.
2. Stage resolved files: `git add -A`.
3. Continue the rebase: `git -c core.editor=true rebase --continue`.
   If it stops again on more conflicts, repeat steps 1-3 until the rebase
   completes (no rebase in progress).
4. Verify: `git status` is clean and no conflict markers remain
   (`git grep -nE '^(<<<<<<<|=======|>>>>>>>)'` finds nothing).
5. Do NOT push. Do NOT open or merge a PR. Do NOT amend unrelated commits.
   Stop once the rebase is complete and the tree is clean.

If the conflict cannot be resolved without losing correctness, abort the rebase
(`git rebase --abort`) and stop — the system will route this to human review.
```

The Claude provider's `COMMIT_PREAMBLE` would wrongly instruct a separate commit; resolution uses the bare prompt without that preamble. Two options:

- **Chosen:** the resolution prompt is passed as a normal task prompt but the resolver does not depend on the commit preamble being absent — the instructions explicitly say "do not push / do not open PR" and the rebase-continue itself creates the commits, so even if the preamble's `git add -A` + `commit` ran, it would no-op after `rebase --continue` (clean tree). Verification (`statusIsClean` + `isRebaseInProgress` false + build) is the real gate, not the prompt wording. This avoids forking the provider contract.

### Success detection

Success is gated by `verifyResolution`, not by the agent's self-report:

1. Rebase is no longer in progress (`isRebaseInProgress === false`), after at most one engine-side `rebaseContinue` recovery if the agent staged but didn't continue.
2. No conflict markers (`hasConflictMarkers === false`).
3. Working tree clean (`statusIsClean === true`).
4. Build verification green (`quality.run().status !== "failed"`), when quality config is present.

All four must hold. Any miss → unresolved → abort → needs-review.

### Build verification

Reuse the quality plugin. `.minions/quality.json` already defines the project's build/typecheck/lint commands and the `ExecQualityPlugin` runs them with timeouts and tail capture. The resolver loads config from the **worktree** path (config travels with the branch) and runs it post-rebase. Required-check failure → unresolved. This avoids inventing a second "build command" config surface (no fallback, reuses the real mechanism). If no quality config exists in the repo, verification is marker-and-clean only, logged explicitly so operators know build wasn't checked.

## Failure and fallback behavior

The terminal fallback is the **existing** needs-review path, reached deliberately:

| Condition | Outcome |
|-----------|---------|
| No `providerFactory` (stub mode) | `MergeService` uses aborting `rebase`; conflict → `merge-conflict` → needs-review (today's behavior). |
| Resolver configured, agent resolves + build green | `complete-conflict-resolution` → merge proceeds → `merged`. |
| Agent leaves markers / build red / fatal-errors / no `final` | `git rebase --abort`; `fail-conflict-resolution` → needs-review with `attempted: true` conflict artifact. |
| Task already has `attempted: true` conflict artifact | Resolver skipped; aborting `rebase` → `merge-conflict` → needs-review. (Loop guard: never two attempts.) |
| Signal aborted mid-resolution | `runProviderToCompletion` exits via the abort signal; resolver aborts rebase, leaves task in `resolving-conflict` for boot recovery (see crash recovery). |

`LandWorkflowService` is unchanged: a `merged` task continues the cascade; a `needs-review` task halts it. The `LandWorkflowResult.conflicted` field still reports the first unresolved task.

## Crash-recovery considerations

Resolution is synchronous within a land POST, but the engine can crash or restart mid-resolution, leaving a task in `resolving-conflict` with a half-finished rebase in the worktree and possibly a live runtime session.

Recovery is handled by extending boot recovery (`application/boot.ts` / `recovery-service.ts`), consistent with how `running` and gate states recover today:

- On boot, any task in `resolving-conflict` is treated as **interrupted resolution**: the engine cannot trust a partially-resolved worktree.
- Action: abort the in-worktree rebase (`git rebase --abort` against the task's worktree if it still exists), stop any associated runtime session, and apply `fail-conflict-resolution` with a conflict artifact marked `attempted: true, reason: "engine restarted during resolution"`. This routes the task to needs-review — the safe terminal — and the `attempted` flag prevents a re-land from retrying resolution.
- This requires a recovery rule for `resolving-conflict`. Add it to the boot recovery's status handling alongside the existing stale-state handling. A new transition is **not** needed for recovery; `fail-conflict-resolution` (from `resolving-conflict`) is the recovery transition.

Rationale for "abort, don't resume": a half-applied rebase with partial agent edits is not safely resumable without re-running the agent, and re-running would violate the single-attempt cap. Needs-review with a clear artifact is the correct, honest terminal. Operators (or a manual retry) can re-drive land after reviewing.

Durability ordering: `start-conflict-resolution` is persisted before the runtime session starts, so a crash after spawn but before completion always leaves the task in `resolving-conflict` (recoverable), never silently stuck in `pr-open`.

## Observability

- New `merge-phase` phase `resolveConflict` (started/completed, with `error` on failure) emitted by the resolver via the same transient-event channel `MergeService` uses. UI timeline gains a "resolving conflict" phase.
- Provider events from the resolution run are published as `provider-event` envelopes (same shape as task runs) so the resolution transcript is visible. The resolution run gets its own `runId`-like correlation; since it is not a task run, publish under a synthetic `runId` of the form `resolve-${taskId}-${attempt}` or omit run correlation and tag events with the phase. Chosen: publish as transient `provider-event` with `runId = resolve-${taskId}-${attempt}` for grouping, not persisted to the task's `runs[]` (it is not a task attempt).
- `resolving-conflict` execution status surfaces in workflow snapshots and the status renderer.

## Ordered implementation checklist

1. `domain/types.ts`: add `resolving-conflict` to `TASK_EXECUTION_STATUSES`; add it to `TASK_CLAIM_HOLDING_STATUSES`.
2. `application/transitions.ts`: add `start-conflict-resolution`, `complete-conflict-resolution`, `fail-conflict-resolution` to `TRANSITION_KINDS` and `TRANSITIONS`.
3. `packages/shared/src/event.ts`: add `resolveConflict` to `MergePhase`.
4. `plugins/git/git-client.ts`: add `listConflictedFiles`, `hasConflictMarkers`, `addAll`, `rebaseContinue`, `rebaseAbort`, `isRebaseInProgress`, `statusIsClean` (+ private `pathExists`).
5. `plugins/scm-plugin.ts`: add `rebaseLeaveConflicts` to the interface.
6. `plugins/github/github-scm-plugin.ts`: implement `rebaseLeaveConflicts` using `listConflictedFiles` (no abort).
7. `plugins/conflict-resolver.ts`: define `ConflictResolver` port + request/outcome types.
8. `plugins/providers/run-provider-sync.ts`: `runProviderToCompletion`.
9. `application/conflict-resolution-service.ts`: implement `ConflictResolver` (transitions, prompt, spawn, verify, push, fallback).
10. `application/merge-service.ts`: add `conflictResolver?` dep; rewire rebase step; add `ResolutionFailedError`; `hasFailedResolution` guard; `handlePhaseError` branch.
11. `engine.ts`: construct `ConflictResolutionService` when `providerFactory` + git client present; pass to `MergeService`.
12. Boot recovery: handle `resolving-conflict` → abort rebase, stop session, `fail-conflict-resolution` with `attempted: true`.
13. Update `test/fixtures/fake-scm.ts`: add `rebaseLeaveConflicts` (mirror `rebase`, but leave a synthetic conflict state) and a `conflictThenResolvable` mode for integration tests.
14. Tests (below).
15. Run `pnpm -C packages/engine typecheck && pnpm -C packages/engine test`; run integration suite with `MWF_HAS_GIT=1`.

## Test plan

Mirror the existing harness: `vitest`, in-memory repo, `FakeSCM`, `StubRuntimeBackend`, `StubProviderPlugin` for unit; the `MWF_HAS_GIT`-gated real-git harness for integration.

### Unit — transitions (`test/application/transitions.test.ts` or new file)

- `start-conflict-resolution` valid from `pr-open` and `finalizing`; invalid from `running`/`merged`/`needs-review`.
- `complete-conflict-resolution` from `resolving-conflict` → `pr-open` (default) and → `finalizing` (when `reason === "finalizing"`).
- `fail-conflict-resolution` from `resolving-conflict` → `needs-review`, appends artifacts.

### Unit — `ConflictResolutionService` (new `test/application/conflict-resolution-service.test.ts`)

Use `StubProviderPlugin` (canned `final` frame), `StubRuntimeBackend`, a fake `GitClient` (or spy) whose `isRebaseInProgress` / `hasConflictMarkers` / `statusIsClean` / `rebaseContinue` are scriptable, and a stub `QualityPlugin`.

- **Resolved, build green:** rebase-not-in-progress + no markers + clean + quality `passed` → returns `{ kind: "resolved" }`, applies `start-` then `complete-conflict-resolution`, calls `scm.pushBranch`.
- **Agent staged but did not continue:** `isRebaseInProgress` true once, then `rebaseContinue` → clean → success.
- **Markers remain:** `hasConflictMarkers` true → `{ kind: "unresolved" }`, `rebaseAbort` called, `fail-conflict-resolution` applied with `attempted: true` artifact.
- **Build red:** quality `failed` → unresolved → needs-review.
- **Agent fatal error / no final:** stub provider emits non-recoverable error / no `final` → unresolved.
- **No quality config:** `loadConfig` returns `[]` → verification passes on markers-and-clean; assert it does not call `quality.run` with empty config (or asserts the logged "build not verified").
- **Signal aborted:** abort signal set → resolver aborts rebase, does not apply `complete-`.

### Unit — `MergeService` resolution wiring (extend `test/application/` merge tests)

- **Resolver resolves:** `FakeSCM.rebaseLeaveConflicts` returns conflict; injected resolver returns `resolved`; assert `merge()` proceeds to `mergePullRequest` and task ends `merged`.
- **Resolver fails:** resolver returns `unresolved` (already applied needs-review); assert `merge()` returns task in `needs-review`, does NOT call `mergePullRequest`, does NOT re-apply `merge-conflict` (no double-transition error).
- **No resolver configured:** conflict → `merge-conflict` → needs-review (today's behavior unchanged).
- **Loop guard:** task already carries `attempted: true` conflict artifact → resolver not invoked, aborting `rebase` used → needs-review.

### Unit — `LandWorkflowService` cascade (extend `test/application/land-workflow-service.test.ts`)

- **A→B→C, B conflicts but resolves:** A merged, B resolved+merged, C merged; `result.conflicted` undefined; resolver invoked once for B.
- **A→B→C, B conflicts and resolution fails:** A merged, B needs-review, C skipped (today's halt semantics preserved); `result.conflicted === "B"`.
- **Parallel siblings B,C off A both editing same file:** order [A,B,C]; after A merges, B rebases (clean), C rebases (conflict→resolved); both end merged. Validates per-task resolution on the cascade.

### Unit — `runProviderToCompletion` (`test/plugins/providers/run-provider-sync.test.ts`)

- Final received → `finalReceived: true`, `sessionRef` captured.
- Non-recoverable error then final → `fatalError` set, `finalReceived: true`.
- Stream ends without final → `finalReceived: false`.

### Unit — `GitClient` helpers (extend `test/plugins/git/git-client.test.ts`, gated by real git where needed)

- `listConflictedFiles`, `hasConflictMarkers` (exit-1 → false, match → true), `statusIsClean`, `isRebaseInProgress` true/false, `rebaseContinue` clean vs re-conflict.

### Integration — real git (`test/plugins/workspace/`-style, `MWF_HAS_GIT=1`)

End-to-end against real worktrees with `FakeSCM` for PR state:

- Build a repo where two branches edit the same line. Land via `MergeService` with a **scripted** resolver that performs the real `git add -A` + `rebaseContinue` (simulating a perfect agent, since spawning a real Claude agent in CI is out of scope). Assert: rebase completes, no markers, branch pushed, PR merges, task `merged`.
- Same setup, resolver that leaves markers → assert abort + needs-review + `attempted` artifact.

This proves the git-client primitives and the `MergeService`↔resolver contract against real git without requiring a live model in CI. The agent-spawn path itself is covered by the `ConflictResolutionService` unit tests with `StubProviderPlugin`.

## Risks

| Risk | Mitigation |
|------|-----------|
| Agent pushes / opens PR / mangles unrelated commits. | Prompt forbids it; verification gates on clean tree + markers + build, not agent self-report; resolver owns the push. |
| Partial multi-stop rebase leaves a half-state. | `verifyResolution` checks `isRebaseInProgress`; on crash, boot recovery aborts and routes to needs-review. |
| Build verification slow/hangs during land (synchronous POST). | Quality plugin already enforces per-check timeouts; `qualityDefaultTimeoutMs` configurable; land is already a blocking long-call. |
| No `.minions/quality.json` → "resolved" without real build check. | Marker-and-clean verification still applies; explicit log; documented limitation. Not a silent fallback — it is the honest behavior when no build is configured. |
| Infinite resolve↔land loop. | Single attempt per land (`maxAttempts`), enforced by `attempted: true` artifact guard in `MergeService`. |
| Force-with-lease push race vs. concurrent CI babysitter. | Land is serial; resolver pushes once; existing `isStalePushRejection` fetch-retry in `pushBranch` covers stale-lease. |
| `resolving-conflict` confuses scheduler/claim accounting. | Added to `TASK_CLAIM_HOLDING_STATUSES` only; excluded from agent-occupying and terminal sets; serial land is not concurrency-gated. |
| Resolver run leaks a runtime session on error. | `ConflictResolutionService` stops the session in a `finally` (mirror `retry-task-service`'s `runtime.stop` on failure). |
| Spawning a model in CI is infeasible. | Integration tests use a scripted resolver doing real git; agent-spawn covered by stub-provider unit tests. |
