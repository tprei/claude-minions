# Architecture — claude-minions

> Read this fully before writing code in this repo. Sub-agents must follow these conventions.

## Repo layout

```
claude-minions/
├── package.json              pnpm workspaces, scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── shared/               wire-format types — DO NOT add runtime logic here
│   │   └── src/
│   │       index.ts
│   │       session.ts transcript.ts dag.ts checkpoint.ts memory.ts
│   │       external-task.ts audit.ts quality.ts readiness.ts pr.ts
│   │       resource.ts runtime-config.ts command.ts event.ts diff.ts
│   │       screenshot.ts loop.ts stats.ts push.ts entrypoint.ts
│   │       version.ts api.ts
│   ├── engine/               long-running HTTP service
│   │   └── src/
│   │       cli.ts            entrypoint, reads env, starts server
│   │       index.ts          createEngine() factory
│   │       env.ts            env parsing + defaults
│   │       logger.ts         pino-style minimal logger
│   │       errors.ts
│   │       http/             routes/*, server.ts, auth.ts, sse.ts
│   │       store/            sqlite.ts, migrations/, repos/*Repo.ts
│   │       bus/              eventBus.ts (in-process pub/sub)
│   │       sessions/         registry.ts, transcriptCollector.ts, replyQueue.ts, screenshots.ts, diff.ts, checkpoints.ts
│   │       providers/        provider.ts (interface), claudeCode.ts, mock.ts, registry.ts, assets/ (instructions templates)
│   │       workspace/        cloner.ts, worktree.ts, depsCache.ts, assetInjector.ts, paths.ts
│   │       dag/              scheduler.ts, model.ts
│   │       ship/             coordinator.ts, stages.ts, mutex.ts
│   │       landing/          manager.ts, restack.ts, stackComment.ts
│   │       loops/            scheduler.ts
│   │       variants/         judge.ts, runner.ts
│   │       ci/               babysitter.ts, prLifecycle.ts, githubClient.ts, askpass.ts
│   │       quality/          gates.ts, runner.ts
│   │       readiness/        compute.ts
│   │       memory/           store.ts, review.ts, mcpServer.ts, preamble.ts
│   │       digest/           summarizer.ts
│   │       audit/            log.ts
│   │       resource/         monitor.ts, cgroup.ts
│   │       push/             notifier.ts
│   │       runtime/          overrides.ts, schema.ts
│   │       intake/           externalTasks.ts
│   │       completion/       dispatcher.ts, handlers/*.ts
│   │       util/             ids.ts, time.ts, fs.ts, debounce.ts, mutex.ts, jitter.ts
│   └── web/                  PWA
│       └── src/
│           main.tsx          mounts <App/>
│           App.tsx
│           index.css         tailwind base + custom utilities
│           routing/          parseUrl.ts, urlState.ts
│           connections/      store.ts, picker.tsx, addDialog.tsx, qrImport.tsx
│           transport/        rest.ts, sse.ts, snapshotCache.ts (idb)
│           store/            sessionStore.ts, dagStore.ts, memoryStore.ts, resourceStore.ts, runtimeStore.ts, root.ts
│           views/            list.tsx, kanban.tsx, dagCanvas.tsx, shipPipeline.tsx, layout.tsx, header.tsx, sidebar.tsx
│           transcript/       Transcript.tsx, events/*.tsx (one per kind)
│           chat/             ChatSurface.tsx, slashCommands.ts, autocomplete.tsx, attachments.tsx, voice.ts, quickActions.tsx, feedback.tsx
│           memory/           Drawer.tsx, list.tsx, edit.tsx, review.tsx
│           runtime/          Drawer.tsx, autoForm.tsx
│           resource/         Indicator.tsx, Panel.tsx
│           pwa/              install.ts, offline.ts, push.ts, gestures.ts, haptics.ts, theme.ts, qr.ts
│           components/       Button, Pill, Diff, Markdown, Spinner, ResizeHandle, Sheet, Modal, ...
│           util/             time.ts, classnames.ts
│           hooks/            useFeature.ts, useReactive.ts, useResize.ts, useTheme.ts
└── docs/
    └── architecture.md       this file
```

## Conventions

### Module system
- All packages are ESM (`"type": "module"`).
- Source uses `.ts`/`.tsx` and imports neighbors with **`.js` extension** (TypeScript NodeNext-style). Example: `import { foo } from "./bar.js"`. This stays correct after compilation.
- The shared package re-exports everything from `./index.js`.

### Strictness
- Strict TS, `noUncheckedIndexedAccess` on. Handle the `T | undefined` from arrays and records.
- Never use `any`. Use `unknown` and narrow.
- No `// @ts-ignore` / `// eslint-disable`. Fix the underlying issue.

### Error model
- Engine errors thrown as `EngineError` with `code` (`bad_request | not_found | conflict | unauthorized | forbidden | internal | upstream`). HTTP layer maps to status codes.
- Web treats every non-2xx as `ApiError` (shape from `@minions/shared`).

### Logging
- One tiny logger (`logger.ts`) — `info|warn|error|debug` with structured fields, level from `MINIONS_LOG_LEVEL`. No third-party logger dep.

### Time
- ISO-8601 strings on the wire. `new Date().toISOString()`.
- Internal monotonic durations use `performance.now()` for resource monitor only.

### IDs
- Slugs: `nanoid(10)` lowercase + `-`. Sessions, DAG nodes, memories, etc. all use these. Never expose database row IDs.

### SSE wire format
- One event-stream endpoint: `GET /api/events?token=...`.
- Each frame is `event: <kind>\ndata: <json>\n\n`. Hello frame on connect, periodic ping every 25s.
- Snapshot semantics — each frame carries the full object, the client replaces. No deltas.

### Concurrency primitives
- `util/mutex.ts` — keyed async mutex (one promise per key, auto-released on resolve/reject).
- `util/debounce.ts` — leading+trailing debounce.

### Storage
- One sqlite file `<workspace>/engine.db`, WAL mode, foreign keys on.
- Migrations are numbered SQL strings in `store/migrations/`. Bootstrapped in order at boot. A `meta` table tracks `schemaVersion`.
- Repos are class-per-table with prepared statements; no ORM.

### Filesystem layout
```
<workspace>/
  engine.db
  engine.db-wal / engine.db-shm
  .repos/<repo-id>.git           bare clone
  .repos/v3-<repo-id>-deps       hardlink cache root
  <session-slug>/                worktree
  <session-slug>/.minions/...    per-session metadata, screenshots, audit
  home/<provider>/               agent CLI auth dir (mounted)
  reply-queue/<session-slug>.jsonl  disk-backed reply queue
  uploads/<session-slug>/        attachments
  audit/audit.log                jsonl audit trail
```

### Subprocess spawning
- All agent CLI calls go through `providers/*.ts` which yield typed events from a streaming reader.
- Never inherit ambient credentials except a mounted home directory or env-passed API key.
- Provider parses **NDJSON** by default; a fallback line-buffered text mode exists for the mock provider.

### Git operations
- `simple-git` only. Never shell out raw `git` from feature code; route through `workspace/worktree.ts` and `landing/manager.ts`.
- Always pass `cwd` explicitly. Never rely on process cwd.

### Testing
- Node's `node:test` runner. Test files live next to their subject as `*.test.ts`.
- Sub-agents: do not insist on full coverage, but write at least one happy-path test per non-trivial module.

## REST surface (v1)

All routes prefixed `/api`. Bearer auth on every route except `/health`. SSE auth via `?token=`.

```
GET    /api/health
GET    /api/version
GET    /api/sessions
GET    /api/sessions/:slug
POST   /api/sessions
DELETE /api/sessions/:slug
GET    /api/sessions/:slug/transcript
GET    /api/sessions/:slug/diff
GET    /api/sessions/:slug/screenshots
GET    /api/sessions/:slug/screenshots/:filename
GET    /api/sessions/:slug/pr
GET    /api/sessions/:slug/readiness
GET    /api/sessions/:slug/checkpoints
POST   /api/sessions/:slug/checkpoints/:id/restore
POST   /api/sessions/variants
GET    /api/dags
GET    /api/dags/:id
POST   /api/commands                  — Command discriminated union
POST   /api/messages                  — { sessionSlug?, prompt, ... } convenience
POST   /api/entrypoints
GET    /api/stats
GET    /api/stats/modes
GET    /api/stats/recent
GET    /api/metrics                   — prom-style text
GET    /api/readiness/summary
GET    /api/audit/events
GET    /api/memories
POST   /api/memories
PATCH  /api/memories/:id
PATCH  /api/memories/:id/review
DELETE /api/memories/:id
GET    /api/config/runtime
PATCH  /api/config/runtime
GET    /api/push/vapid-public-key
POST   /api/push-subscribe
DELETE /api/push-subscribe
GET    /api/events                    — SSE
```

## Event bus

`bus/eventBus.ts` exports a typed pub/sub:

```ts
type Listener<T> = (event: T) => void;
class EventBus {
  on<K extends ServerEvent["kind"]>(kind: K, fn: Listener<Extract<ServerEvent, { kind: K }>>): () => void;
  onAny(fn: Listener<ServerEvent>): () => void;
  emit(event: ServerEvent): void;
}
```

Completion handlers register on session_updated where `status` transitions to a terminal state.

## Session lifecycle (key sequences)

### Create
1. `POST /api/sessions` validated → `SessionRegistry.create()`.
2. Insert row (status `pending`).
3. Bare clone (or reuse cache) → `git worktree add` → bootstrap deps (hardlink) → asset injection.
4. Spawn provider subprocess with prompt.
5. `transcriptCollector` consumes stdout, persists events, emits `transcript_event`.
6. On terminal stop → `completion/dispatcher` runs handlers in order.

### Resume on boot
1. Load all sessions where `status` is `running` or `waiting_input`.
2. For each, call `provider.resume(sessionId)`. If resume fails, mark `failed`.
3. Drain `replyQueue` into resumed processes.

### Reply
1. Operator sends `reply` command.
2. If session running → write to provider stdin and store as `user_message` event.
3. Else → enqueue to `replyQueue/<slug>.jsonl`. Drained when session re-enters running.

### Stop
1. Mark session `cancelled`. Send SIGINT, then SIGKILL after 5s. Final transcript event status=cancelled. Emit `session_updated`.

### Close
1. Stop (if running) → drop worktree + branch (if `removeWorktree`) → keep DB row. Emit `session_deleted` only if hard-deleted.

## DAG scheduler

- DAG creation: parsed from agent JSON output (a `DAGNode[]`-shaped emission detected by the transcript collector when a session in `dag` ship-stage produces fenced JSON), or built manually via `/split`.
- On `dag_updated` and on session terminal events: walk nodes; any `pending` whose deps are all `done|landed` → mark `ready` and spawn a `dag-task` session bound to that node. Reserve a per-DAG concurrency cap (default 3).
- When a node session completes successfully **and** quality + readiness pass → run landing manager → mark `landed`. On readiness failure → `ci-failed`. On rebase conflict → spawn `rebase-resolver`.

## Ship coordinator

- `ship` mode session has stages `think → plan → dag → verify → done`.
- Each transition holds a per-session mutex (keyed by slug). Only one transition can run at a time.
- Stage transition writes a `status` transcript event, optionally injects a stage-specific directive into the next turn, and persists the new stage in `sessions.shipStage`.
- Force release available via `force` command.

## Memory subsystem

- Memories have lifecycle `pending → approved → rejected | superseded | pending_deletion`.
- The agent never sees memories directly via prompt — they come through:
  1. **Preamble**: approved global + repo-scoped memories rendered into the system instructions injected at session creation.
  2. **MCP-style server**: spawned alongside the agent, exposing `list_memories`, `get_memory`, `propose_memory`. Proposals land as `pending`.
- Operator approves/rejects via `PATCH /api/memories/:id/review`. Approved memories take effect on the next session.

## Quality gates / readiness

- Per-repo gate config (env or `<repo>/.minions/quality.json`) — list of `{ name, command, cwdRel?, timeoutMs? }`.
- After a turn completes, a `QualityRunner` queues per session (debounced). Outcome stored as `QualityReport`.
- Readiness composes: PR open + not draft, required reviews, last `QualityReport.status === passed`, no failed CI checks, branch ahead of base, no rebase-conflict.

## Loops

- A `LoopDefinition` row defines an interval and prompt.
- `loops/scheduler.ts` ticks every 5s. For loops whose `nextRunAt` has passed and `enabled` is true and concurrent-loop count < cap, spawn a `loop`-mode session. On terminal failure: increment `consecutiveFailures` and apply exponential backoff (`min(intervalSec * 2^failures, 86400)`).
- Reserved interactive slots (default 4) — loops cannot occupy them.

## Variants + judge

- `POST /api/sessions/variants` with `{prompt, count}` spawns N parallel sessions sharing a `variantParentSlug`.
- When all complete (or N-1 within timeout): `variants/judge.ts` runs `extract → advocate → judge` prompt loop on a fresh sub-session, picks a winner with rationale, posts as a `status` event on the parent.

## Resource monitor

- `resource/monitor.ts` samples every 2s.
- CPU: read `/sys/fs/cgroup/cpu.stat` if present (cgroup v2), else `os.loadavg() / cpus`.
- Memory: `/sys/fs/cgroup/memory.current` + `memory.max` if cgroup, else `os.freemem()/totalmem()`.
- Disk: `statvfs` on workspace.
- Event-loop lag: `monitorEventLoopDelay()` from `node:perf_hooks`, mean over the window.
- Emits `ResourceEvent` to bus → SSE.

## Push notifier

- VAPID keys from env. Subscriptions persisted in sqlite.
- Fires when an `AttentionFlag` is added to a session, or when a CI failure / rebase conflict / judge-review attention raises.

## Runtime overrides

- Live-editable subset declared in `runtime/schema.ts`. Persisted in sqlite (`runtime_config` row, single-row).
- On `PATCH /api/config/runtime`, the engine updates the row, applies values to live subsystems (e.g., loop interval, memory MCP toggle, quota retry budget), and broadcasts a `session_updated`-shaped no-op so clients refetch on demand (clients also poll on focus).

## Web client conventions

- Reactive primitives: zustand stores with shallow subscribers.
- IndexedDB cache: `connection:<id>:state` key holds last sessions+dags snapshot.
- SSE: full-jitter exponential backoff (`base=1000ms`, `cap=30s`); on every successful (re)connect refetch `/api/sessions` and `/api/dags`.
- All capability-gated UI uses `useFeature("name")` hook.
- Slash commands: a registry `slashCommands.ts` exports `{name, args[], hint, build(args): Command}` so autocomplete + dispatch share one source of truth.

## Wire stability

- The shared types are the only public contract between engine and web. Never branch behavior on `apiVersion` strings — always check `features[]`. Versioned schema migrations live entirely inside the engine.

## Sub-agent rules

- Edit only files inside the directories you were assigned. If your task requires touching a sibling subsystem, expose a thin interface and leave the impl to the owner.
- Always import shared types from `@minions/shared`. Never duplicate type definitions.
- Always use `.js` extension on internal imports.
- Always use `cwd`-aware `simple-git` calls; never assume process cwd.
- Default exports are forbidden; use named exports.
- No code comments unless the WHY is non-obvious.
- One named export per file when practical, otherwise group by feature.
- Never fall back silently. Throw with a useful message.
- Never bake credentials into source. Read from env or mounted dir.

