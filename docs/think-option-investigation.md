# `think` thread option — enforcement audit

Investigation of the existing engine so a new `think` thread option can guarantee:
1. **Single node** — runs as one task, no planner / task graph / sub-agents.
2. **Read-only** — no Edit/Write, no mutating Bash, no external system writes.

## 1. Where `think` already lives (declared, partly wired)

| Layer | File | Status |
|---|---|---|
| Shared session mode enum | `packages/shared/src/session.ts:14-26` (`"think"` in `SESSION_MODES`) | Declared |
| Shared ship-stage enum | `packages/shared/src/session.ts:28` (`ShipStage = "think" \| ...`) | Declared |
| Shared bucket enum | `packages/shared/src/session.ts:33-37` (`"think"` in `SESSION_BUCKETS`) | Declared |
| Domain workflow kind | `packages/engine/src/domain/types.ts:6-15` (`"think-thread"` in `WORKFLOW_KINDS`) | Declared |
| Domain factory | `packages/engine/src/domain/workflow.ts:88-102` (`createThinkThreadWorkflow`) — single task, `maxConcurrent: 1`, **drops `mergeTarget` from the TaskSpec type** | Implemented but **not called from anywhere in `src/`** (only `test/workflow.test.ts`) |
| Slash command (PWA) | `packages/web/src/chat/slashCommands.ts:78-85` (`/think`) | Hooked to `mode: "think"` payload (UI message metadata, not a workflow kind) |
| List view label | `packages/web/src/views/list.tsx:268,275` (renders `think-thread` as "think") | Display only |
| Permission tier enum | `packages/shared/src/session.ts:30-31` (`PERMISSION_TIERS = ["read", "worktree", "full"]`) | **Declared but never read** anywhere in engine code |

Key gap: the `PermissionTier` type and the `think-thread` workflow kind both exist but nothing in `packages/engine/src` reads them. They are dead declarations waiting to be wired.

## 2. Property (1) — single node, no task graph, no sub-agents

There are two layers to enforce.

### 2a. Skip the planner so no DAG is created

The planner is the only thing that emits multi-node workflows from a free-text prompt.

- HTTP entry: `POST /workflows/plan` → `packages/engine/src/transport/server.ts:144-163` → `WorkflowPlannerService.plan` (`packages/engine/src/application/planner-service.ts:198-266`). Planner system prompt at `planner-service.ts:20-38` is what mints `t0`, `t1`, … task ids. `VALID_KINDS = {"single-task", "manual-dag"}` (`planner-service.ts:6`) — `think-thread` is **not** an accepted planner output, so the planner must be bypassed entirely for think.
- Direct entry: `POST /workflows` accepts a pre-built `WorkflowSpec` (`server.ts:112-142`). This is the bypass.
- UI bypass switch already exists: `packages/web/src/views/newSession.tsx:49,131-159` — `usePlanner` checkbox; when false it calls `makeSingleTaskSpec()` (`newSession.tsx:110-123`) and POSTs directly to `/workflows`.
- Engine-wide kill switch: `MWF_PLANNER_DISABLED` env (`packages/engine/src/engine.ts:310-315`) — when set, `plannerService` is not registered and `/workflows/plan` returns 503; UI falls back to single-task (`newSession.tsx:144-156`).
- Validators do **not** restrict workflow kind (`packages/engine/src/transport/validators.ts:120-124` only checks `kind` is a string); `createWorkflow` checks against `WORKFLOW_KINDS` (`workflow.ts:10-15`).

**Hook for `think`:** add a new branch in `NewSessionView` (or a new entry-point) that builds a `WorkflowSpec` via `createThinkThreadWorkflow` (or inlines `{ kind: "think-thread", policy: { maxConcurrent: 1 }, tasks: [...] }`) and POSTs to `/workflows` directly. **Never call `/workflows/plan` for think mode.**

### 2b. Dispatcher already enforces single-node execution

Because the workflow has one task with no `dependsOn`, `planDispatch` will only ever surface that one task (`packages/engine/src/application/scheduler.ts:10-34`). `maxConcurrent: 1` is enforced via `TASK_AGENT_OCCUPYING_STATUSES` capacity math (`scheduler.ts:13-17`). Nothing new is needed here — the graph shape is the enforcement.

### 2c. Prevent Claude from spawning sub-agents at runtime

This is the real risk. `planDispatch` controls *task-graph* parallelism, but Claude Code inside the runtime can still invoke its own `Task` tool to spawn sub-agents within a single node. The provider command is built at `packages/engine/src/plugins/providers/claude-code.ts:36,44`:

```ts
command: ["claude", "-p", wrapped, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]
```

There is **no current tool allowlist / disallowlist plumbing** — `--dangerously-skip-permissions` accepts everything. `ProviderPrepareSpec` / `ProviderResumeSpec` (`provider-plugin.ts:12-24`) have no fields for restrictions, and `ProviderInvocation` (`provider-plugin.ts:26-30`) is just `{ command, env, providerType }`.

**Hook for `think`:** thread a restriction through the provider. Options, in order of strength:

1. **Plumb a `mode`/`permissionTier` into `ProviderPrepareSpec`** and have `ClaudeCodeProvider.prepare` append `--disallowed-tools Task,Edit,Write,NotebookEdit,Bash` (or use Claude Code's `--permission-mode plan` if the bundled CLI supports it). Match in `resume` for continued think threads.
2. **Drop `--dangerously-skip-permissions`** for think and rely on Claude's default deny-by-default for write tools. Less reliable because the user can't approve prompts in a headless run.
3. **Pre-flight check via `validateCommand` / `createWorkflow`** that a `think-thread` workflow's prompt is enqueued with the restricted provider invocation (defensive — the provider should be the source of truth).

The propagation path needs a new field on `RetryTaskService`/`ContinueTaskService` call sites (`retry-task-service.ts:86`, `continue-task-service.ts:89`) so they pass `workflow.kind` (or a derived `permissionTier`) into `provider.prepare/resume`. The workflow is already loaded in both services (`retry-task-service.ts:44`, `continue-task-service.ts:43`) — just include `kind` in the prepare/resume spec.

## 3. Property (2) — read-only (no FS / external writes)

Three places do mutations a think run must skip.

### 3a. Provider-internal mutations (Edit / Write / Bash)

Same hook as 2c. The `--disallowed-tools` (or `--permission-mode plan`) flag on the Claude invocation is the only point of enforcement — once Claude is launched there is no engine-side filter on tool calls (`run-orchestrator.ts:90-99` just streams provider events through `parseFrame`; tool calls are observed for transcript, not gated).

`packages/engine/src/plugins/providers/claude-code.ts:23-30` also defines `COMMIT_PREAMBLE` which **commands the agent to `git add -A` and commit**. For think mode, prepend a different preamble — or drop the preamble entirely — when `workflow.kind === "think-thread"`. The preamble is hard-coded as a static class member; it'll need to become a parameter or branch by spec.

### 3b. Workspace mutations after completion

`LocalFinalizeService` runs on `executionStatus === "finalizing"` (`packages/engine/src/application/local-finalize-service.ts:54-58, 77-79`). It unconditionally attempts to merge the worktree branch into `task.mergeTarget ?? "main"` (`local-finalize-service.ts:154`). Because `createThinkThreadWorkflow` already strips `mergeTarget`, the merge target falls back to `baseBranch ?? "main"` — **still a real merge attempt**. This is a leak; a think thread would push a commit to `main` if the agent committed anything.

`MergeService` (used when GitHub is configured) is gated on `workflow.policy.autoLand` (`completion-dispatcher.ts:118`). `createThinkThreadWorkflow` doesn't set autoLand, and `createWorkflow` defaults it to `false` (`workflow.ts:58`), so the GitHub merge path is safe. The **local** finalize path has no such gate.

**Hook for `think`:** gate `LocalFinalizeService.finalizeTask` (or `tryMerge`) by `workflow.kind`. Either:
- Add a `workflow.kind === "think-thread"` short-circuit at `local-finalize-service.ts:90-93` that transitions straight to `complete-without-pr` without merging, **or**
- Reuse `task.mergeTarget === undefined` as the signal and have `tryMerge` return `{ kind: "merged" }` (no-op) when there's no merge target. This matches the existing `Omit<TaskSpec, "id" | "mergeTarget">` shape in `createThinkThreadWorkflow` and is the cleanest invariant.

The second option is also defensible without a kind check: "no merge target → no merge" is a meaningful contract by itself.

### 3c. Quality gate

`QualityGateService` runs on every `executionStatus === "completed"` transition (`quality-gate-service.ts:62-65, 99-100`). The quality gate is **read-only by intent** — it spawns lint/test commands via `ExecQualityPlugin` (`packages/engine/src/plugins/quality/exec-quality-plugin.ts`) — but it does run real commands in the worktree, which can have side effects (cache writes, network) and adds latency that defeats the "fast think turn" UX.

**Hook for `think`:** either skip the gate by `workflow.kind` in `QualityGateService.spawnRunForTask`, or set `MWF_QUALITY_DISABLED=1` at the engine level (`engine.ts:378-403`, `main.ts:51,55`) — the latter is global, not per-workflow, so a per-kind branch in the service is preferable.

### 3d. Other side-effecting services to audit

- `CIBabysitterService` (only attached when GitHub is configured + autoLand path; gated by `prArtifact` existing — think won't open a PR so this is naturally inert).
- `CompletionDispatcher` → `MergeService.openOnly` (`completion-dispatcher.ts:122`) — gated by `workflow.policy.autoLand` which defaults to `false`. Safe by default.
- `PushService` / supervisor / observability — all read-only event projection. Safe.
- `RetryTaskService` and `ContinueTaskService` — call `workspace.create({ mode: "worktree", resetBranch: true })` (`retry-task-service.ts:76-82`). A worktree is still created on disk; this is fine because the worktree is sandboxed and cleaned up. The think prompt should still get a worktree so Read/Grep work — just no merge.

## 4. Concrete change list to implement `think`

Touch points, in dependency order:

1. **`packages/engine/src/plugins/provider-plugin.ts`** — add an optional restriction hint to `ProviderPrepareSpec` and `ProviderResumeSpec`, e.g. `permissionTier?: "read" | "worktree" | "full"` or `workflowKind?: WorkflowKind`. The `PermissionTier` enum already exists in `packages/shared/src/session.ts:30-31`; reuse it.
2. **`packages/engine/src/plugins/providers/claude-code.ts`** — branch on the new field:
   - When read-only: omit `--dangerously-skip-permissions`, add `--disallowed-tools Task,Edit,Write,NotebookEdit,Bash` (or `--permission-mode plan` if the installed `claude` binary supports it — verify before shipping), and skip the `COMMIT_PREAMBLE`.
   - Keep current behavior for `worktree`/`full`.
3. **`packages/engine/src/plugins/providers/codex.ts`** — same shape if/when think mode runs on codex (today only `claude-code` is wired through; codex command construction at `codex.ts:26-40` has no equivalent flag — flag as TODO or block think on codex via `MWF_PROVIDER` check).
4. **`packages/engine/src/application/retry-task-service.ts:86`** and **`continue-task-service.ts:89`** — load `workflow.kind` (already in scope) and pass `permissionTier: workflow.kind === "think-thread" ? "read" : "full"` into `provider.prepare/resume`.
5. **`packages/engine/src/application/local-finalize-service.ts`** — at the top of `finalizeTask` (line 90) or `tryMerge` (line 132), short-circuit when `workflow.kind === "think-thread"` (or when `task.mergeTarget === undefined` — see §3b option 2) and dispatch `complete-without-pr` directly.
6. **`packages/engine/src/application/quality-gate-service.ts:62-65,99-100`** — skip `spawnRunForTask` when the workflow kind is `think-thread`. Requires loading the workflow in `consume`/`attachAsync` (already loaded at `attachAsync` line 56) and either caching `kind` on the iterator or re-fetching in `spawnRunForTask`.
7. **`packages/web/src/views/newSession.tsx`** — add a "Think (read-only)" entry-point (button or mode toggle) that builds `{ kind: "think-thread", policy: { maxConcurrent: 1 }, tasks: [{ id, title, prompt }] }` and POSTs to `/workflows`. Do **not** route through `/workflows/plan`.
8. **`packages/web/src/chat/slashCommands.ts:78-85`** — `/think` currently emits `{ kind: "message", payload: { mode: "think" } }`, which is consumed by whatever handles slash-command messages in the chat surface. Verify that handler routes to the new think-thread workflow creation path; if it currently routes the same as `/task`, update it.

## 5. Tests to add

- `packages/engine/test/plugins/providers/claude-code.test.ts` — argv contains `--disallowed-tools Task,...` (or `--permission-mode plan`) and omits `--dangerously-skip-permissions` when `permissionTier === "read"`.
- `packages/engine/test/application/local-finalize-service.test.ts` — a `think-thread` workflow finalizes via `complete-without-pr` without invoking the git merge path.
- `packages/engine/test/application/quality-gate-service.test.ts` — quality gate is skipped for `think-thread`.
- `packages/engine/test/transport/workflows.test.ts` — `POST /workflows` with `kind: "think-thread"` is accepted (kind is already in `WORKFLOW_KINDS`, but worth a regression test).

## 6. Risks / open questions

- **Does the bundled `claude` CLI support `--disallowed-tools` and `--permission-mode plan`?** Need to verify against the version in `Dockerfile`. If not, fall back to omitting `--dangerously-skip-permissions` and relying on interactive deny-by-default — which won't work in headless mode and may cause stalls. Confirm before relying on either flag.
- **`COMMIT_PREAMBLE` is static** — refactor to a per-spec preamble OR branch inside `prepare()` on the new field. Today it forces a commit, which is exactly the opposite of read-only.
- **Codex provider has no tool-restriction mechanism in the current command shape.** Either block `think` for codex (`MWF_PROVIDER=codex`) or land codex support as a follow-up.
- **`PermissionTier` is a vocabulary the codebase already declared.** Using it (vs. branching on `workflow.kind` everywhere) gives a single knob that future workflow kinds (e.g. `review`) can reuse.
