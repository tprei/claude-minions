# Dogfood tasks — claude-minions parity + resilience push

Each task below is a single, scoped dispatch for the dogfood loop. They're written so one agent session can own each end-to-end (30–80 turns). Phases are ordered so blockers land before features that depend on them. Don't run two tasks in parallel that touch the same file (see `references/dispatch-prompt-template.md`).

Each task gives:
- **why** — the one-line motivation
- **scope** — directories/files the agent may touch
- **do** — bullet list of behaviour-level changes (not implementation prescriptions)
- **done-when** — observable criteria (typecheck, test, REST behaviour, browser behaviour)

Stop the loop and surface issues whenever a task can't satisfy its done-when. Don't ship partials.

---

## Phase 0 — Truth & wiring (must precede everything else)

These exist because the executive review showed several advertised capabilities are partial, unwired, or silently fall back. Until these are honest, every later feature is built on a lie.

### T01 — Wire the completion dispatcher into `createEngine()`
- **why:** completion handlers (`completion/handlers/*.ts`) are written but the dispatcher is not subscribed to terminal session events from `createEngine()`, so handlers run inconsistently or not at all.
- **scope:** `packages/engine/src/index.ts`, `packages/engine/src/completion/dispatcher.ts`, `packages/engine/src/completion/handlers/*.ts` (read-only review), `packages/engine/src/bus/eventBus.ts`.
- **do:**
  - Have `createEngine()` instantiate the dispatcher and subscribe it to `session_updated` for terminal-state transitions.
  - Run handlers in declared order; surface failures as `audit_event` rows, never swallow.
  - Add an integration test that a synthetic terminal session triggers each registered handler exactly once.
- **done-when:** terminal session events fire dispatcher; engine test covers it; `audit_events` shows dispatcher rows.

### T02 — Truthful `features[]` in `/api/version`
- **why:** clients gate UI on `features[]`, but features that aren't fully wired are still listed (memory MCP, ship advancement, DAG-from-transcript, screenshots). UI lights up; nothing happens.
- **scope:** `packages/engine/src/http/routes/version.ts` (or wherever `/api/version` lives), `packages/shared/src/version.ts`.
- **do:**
  - Define a feature is "ready" iff every wired prerequisite check returns true at boot (handlers registered, MCP server reachable, DAG parser subscribed, screenshot dir writable, etc).
  - Compute features[] at boot (and on runtime overrides) from these probes; never hand-list.
  - Return both `features[]` (ready) and `featuresPending[]` (declared but not ready) so clients can render disabled affordances.
- **done-when:** `curl /api/version` shows `features[]` shrink/grow with actual readiness; `useFeature("x")` returns false until probes pass.

### T03 — Stop double-scheduling loops
- **why:** review found loops appear to be scheduled twice; doubles every interval-driven dispatch.
- **scope:** `packages/engine/src/loops/scheduler.ts`, `packages/engine/src/index.ts`.
- **do:**
  - Audit `setInterval` / event subscriptions in `loops/scheduler.ts` and ensure scheduler starts exactly once per `createEngine()`.
  - Add a guard so re-import / hot-reload does not register a second tick.
  - Add a test that, given one loop with `intervalSec=1`, exactly one session is spawned per tick.
- **done-when:** test passes; logs at boot show one "loops scheduler started" line.

### T04 — Remove silent Claude→mock fallback
- **why:** if `claude` CLI is missing, the provider silently falls back to mock — production-truth disaster.
- **scope:** `packages/engine/src/providers/registry.ts`, `packages/engine/src/providers/claudeCode.ts`.
- **do:**
  - Detect missing CLI explicitly. Raise `EngineError("upstream", "claude CLI not found")` on session create.
  - Surface in `/api/health` as a `degraded` provider entry instead of silently routing to mock.
  - Mock provider is only selected when explicitly requested via `provider: "mock"` in the create body or env.
- **done-when:** removing `claude` from `$PATH` causes session create to fail with a clear 502, not spawn a mock.

### T05 — Wire memory MCP into provider spawn
- **why:** MCP server exists (`memory/mcpServer.ts`) but is not attached to the agent subprocess; agents can't propose memories at runtime.
- **scope:** `packages/engine/src/memory/mcpServer.ts`, `packages/engine/src/providers/claudeCode.ts`, `packages/engine/src/sessions/registry.ts`.
- **do:**
  - On session start, spawn the MCP server bound to a per-session unix socket / stdio pipe.
  - Pass the connection details to the provider via the standard MCP config (claude-code reads `--mcp-config` or env).
  - Tear down on session terminal.
- **done-when:** during a live session, `propose_memory` from the agent results in a row in `memories` with `status=pending`.

---

## Phase 1 — Contract repair (web ↔ engine)

### T06 — Memory review contract alignment
- **why:** web's review path and engine's `PATCH /api/memories/:id/review` disagree on body shape; review actions silently 400.
- **scope:** `packages/shared/src/memory.ts`, `packages/engine/src/http/routes/memories.ts`, `packages/web/src/memory/*`.
- **do:**
  - Define a single `MemoryReviewCommand` type in shared.
  - Make engine accept that exact shape; web sends that exact shape.
  - Reject unknown fields with 400.
- **done-when:** approve/reject/supersede from the UI mutates the row and emits a `memory_updated` event.

### T07 — Variants endpoint contract
- **why:** review noted duplicate `/api/sessions/variants` registrations and a stub vs real impl. Web posts to one shape; engine accepts another.
- **scope:** `packages/shared/src/api.ts`, `packages/engine/src/http/routes/variants.ts` (or equivalent), `packages/engine/src/variants/runner.ts`, `packages/web/src/...` (call site).
- **do:**
  - Pick the canonical handler; delete the duplicate; ensure only one path is wired in `http/routes/index.ts`.
  - Move request/response shapes to shared; update web call site to import from there.
- **done-when:** `grep -rn 'sessions/variants' packages/engine/src` shows one handler; web variants flow round-trips.

### T08 — Authenticated screenshots + actually capture them
- **why:** screenshot route returns files without bearer auth and many sessions have no screenshots even though the feature is listed.
- **scope:** `packages/engine/src/sessions/screenshots.ts`, `packages/engine/src/http/routes/sessions.ts` (screenshot routes), `packages/engine/src/providers/claudeCode.ts` (capture trigger).
- **do:**
  - Require bearer auth on `/api/sessions/:slug/screenshots/:filename`.
  - Capture screenshots on the events the feature claims to (turn end / readiness change / failure) — declare which.
  - Reject path traversal in `:filename`.
- **done-when:** unauthenticated GET returns 401; running a session produces at least one screenshot file at the documented trigger.

### T09 — Wire DAG creation from transcript
- **why:** `dag/scheduler.ts` exists; the transcript parser that turns a fenced JSON `DAGNode[]` from a `ship.dag` stage session into an actual DAG row is not wired.
- **scope:** `packages/engine/src/sessions/transcriptCollector.ts`, `packages/engine/src/dag/model.ts`, `packages/engine/src/dag/scheduler.ts`.
- **do:**
  - On `transcript_event` whose source is a session in `shipStage="dag"` and whose payload includes a fenced JSON block parseable as `DAGNode[]`, create the DAG and link it to that session as parent.
  - Reject ill-formed JSON with a `status` event back to the session, not a hard fail.
  - Add a test that ingests a fixture transcript and asserts a DAG row is created.
- **done-when:** running a ship session through the dag stage results in a `/api/dags` entry with the right nodes.

### T10 — Ship stage advancement on turn completion
- **why:** ship coordinator persists stages but `think → plan → dag → verify → done` advancement on terminal turns is mostly empty.
- **scope:** `packages/engine/src/ship/coordinator.ts`, `packages/engine/src/ship/stages.ts`, `packages/engine/src/completion/handlers/shipAdvance.ts` (new or existing handler).
- **do:**
  - On terminal session for a `ship`-mode session, advance to the next stage if exit conditions are met (think→plan: a structured plan in the transcript; plan→dag: a parsed DAG; dag→verify: all DAG nodes `landed`; verify→done: readiness pass).
  - Inject the next-stage directive into the resumed turn.
  - Hold the per-session mutex during the transition.
- **done-when:** synthetic ship session in test moves through every stage; force command still releases the mutex.

---

## Phase 2 — SSE & reconnect resilience (foundation for redeploy story)

### T11 — Robust SSE: keepalives, jittered reconnect, visibility/online recovery
- **why:** real users hit suspended tabs / VPN flips / engine restarts. Currently the stream silently drops and the UI shows stale data with no indicator.
- **scope:** `packages/engine/src/http/sse.ts`, `packages/web/src/transport/sse.ts`, `packages/web/src/components/...` connection indicator.
- **do:**
  - Server: emit ping every 25s on `reply.raw` with manual CORS preserved (see known-bugs).
  - Client: full-jitter exponential backoff (`base=1000ms, cap=30s`), reconnect on `visibilitychange` + `online` + `pageshow` events.
  - Client: visible "reconnecting…" pill that auto-clears once a hello frame arrives.
- **done-when:** simulated disconnect (kill engine, restart) restores stream within 30s, with a visible reconnect indicator and no console error storm.

### T12 — Transcript high-water reconciliation
- **why:** during reconnect, frames between disconnect and reconnect are lost. Snapshot-first SSE doesn't catch transcript gaps.
- **scope:** `packages/shared/src/event.ts`, `packages/engine/src/sessions/transcriptCollector.ts`, `packages/engine/src/http/routes/sessions.ts` (transcript endpoint), `packages/web/src/transport/sse.ts`.
- **do:**
  - Each transcript event carries a monotonic `seq` per session.
  - Client tracks last-seen `seq` per session; on reconnect, hits `GET /api/sessions/:slug/transcript?since=<seq>` to backfill.
  - Render order is `seq`-stable.
- **done-when:** integration test: disconnect, emit 5 events server-side, reconnect — UI shows all 5 in order.

### T13 — Per-connection frontend stores
- **why:** with multiple backends configured (`connections/store.ts`), sessions/DAGs from one connection bleed into another's UI because zustand stores are global keys.
- **scope:** `packages/web/src/store/*.ts`, `packages/web/src/connections/store.ts`, all components consuming those stores.
- **do:**
  - Re-key every store by `connectionId`; selectors take `(connectionId)` or read it from `useActiveConnection()`.
  - On switching active connection, components refetch / select against the new id; the prior connection's data stays cached in IDB but does not render.
- **done-when:** with two connections live, sessions list, DAG canvas, resource panel, memory drawer all show only the active connection's data; switching is instant from cache.

### T14 — Resume-on-boot: sessions, DAGs, ship, loops
- **why:** user explicitly wants "redeploy with new features and work continues automatically." Today, restart drops in-flight running sessions and ship/dag state.
- **scope:** `packages/engine/src/index.ts`, `packages/engine/src/sessions/registry.ts`, `packages/engine/src/dag/scheduler.ts`, `packages/engine/src/ship/coordinator.ts`, `packages/engine/src/loops/scheduler.ts`.
- **do:**
  - On `createEngine()`, before HTTP listen: load every `running` / `waiting_input` session; call `provider.resume()` (existing); drain `replyQueue/<slug>.jsonl`.
  - Reconcile DAGs: any `ready` node whose session row is gone is rescheduled; any `landed` whose PR is closed is preserved.
  - Reconcile ship: load `shipStage` and re-arm the coordinator.
  - Reconcile loops: compute `nextRunAt` against wall clock; do not double-fire if the interval elapsed during downtime.
  - All reconciliation logged to `audit_events`.
- **done-when:** kill-and-restart engine while a mock session is running for >60s — session resumes, DAG re-arms, ship stage preserved, no duplicate spawns.

---

## Phase 3 — Chat must-haves

### T15 — Reply injection (CRUCIAL)
- **why:** user calls this out as crucial. Operator must be able to inject a reply mid-turn that the agent picks up without restarting.
- **scope:** `packages/engine/src/sessions/replyQueue.ts`, `packages/engine/src/sessions/registry.ts`, `packages/engine/src/providers/claudeCode.ts`, `packages/web/src/chat/ChatSurface.tsx`, `packages/web/src/chat/quickActions.tsx`.
- **do:**
  - Engine: while a session is `running`, accept `POST /api/commands {kind:"reply",sessionSlug,prompt}`; write to provider stdin and persist a `user_message` transcript event with `injected:true`.
  - If provider is between turns / waiting, enqueue to disk-backed replyQueue; drain on next turn open.
  - Web: send button enabled while running; show a pill on injected messages so operator can see they were enqueued vs accepted.
- **done-when:** during a long-running mock session, sending two replies mid-turn results in both transcript events with correct timing and the agent picks them up on next turn open.

### T16 — Image paste in initial prompt
- **why:** user wants to paste images (file picker + clipboard) when creating a session.
- **scope:** `packages/web/src/chat/attachments.tsx`, `packages/engine/src/http/routes/uploads.ts` (new or existing), `packages/engine/src/sessions/registry.ts`.
- **do:**
  - Web: clipboard `paste` and `<input type=file>` produce `Attachment[]` with previews; upload to `POST /api/uploads` returning a content-addressed url.
  - Engine: store under `<workspace>/uploads/<session-slug>/` once session created; reference by url in the prompt body sent to the provider.
  - Limit: PNG/JPEG/WebP only, max 5MB each, max 5 per message.
- **done-when:** screenshot pasted into the new-session form posts to a real session and the provider receives the image reference.

### T17 — Image paste mid-conversation
- **why:** continuation of T16 — same affordance during an ongoing session.
- **scope:** same as T16, plus `packages/web/src/chat/ChatSurface.tsx`, `packages/engine/src/sessions/replyQueue.ts`.
- **do:**
  - Reuse the upload pipeline from T16; reply commands accept `attachments[]: Url[]`.
  - Provider stdin write includes the attachment refs in claude-code's expected payload shape.
- **done-when:** pasting an image into the chat input during a running session results in the agent receiving it on the next turn.

### T18 — Failure-recovery action surfaces
- **why:** users currently can't see or act on failure states inside chat (retry, resume, abort, restore checkpoint, view PR/CI).
- **scope:** `packages/web/src/chat/ChatSurface.tsx`, `packages/web/src/transcript/events/*.tsx`, `packages/shared/src/readiness.ts`, `packages/web/src/chat/feedback.tsx`.
- **do:**
  - Render a per-turn footer that shows: status (`running|waiting_input|failed|cancelled`), readiness summary (PR open?, CI?, conflicts?), and primary actions: Retry, Resume, Abort, Restore-checkpoint.
  - Every action posts to `/api/commands` with the typed discriminated union; optimistic UI flips immediately, reconciles on event.
- **done-when:** a session that fails shows the footer with action buttons and clicking Retry creates a continuation session linked to the parent.

### T19 — Optimistic feedback for command actions
- **why:** user wants "immediate feedback." Today actions wait for the next SSE round-trip.
- **scope:** `packages/web/src/store/sessionStore.ts`, `packages/web/src/store/dagStore.ts`, `packages/web/src/transport/rest.ts`.
- **do:**
  - Each mutation goes through a tiny "intent → reconcile" path: apply optimistic update keyed by a `requestId`; clear/correct when the matching SSE event arrives or after a 5s timeout (rollback + toast).
  - Pills on optimistic state ("sending…") only appear if the round-trip exceeds 250ms.
- **done-when:** clicking Stop/Reply/Land mutates the visible state instantly, rolls back if the engine rejects, and never gets stuck in a fake state for >5s.

---

## Phase 4 — Operator UX

### T20 — Timeline / raw events view
- **why:** user wants to copy event timelines into an LLM when things go wrong. Currently transcript view buries raw events behind summaries.
- **scope:** `packages/web/src/transcript/Transcript.tsx`, new `packages/web/src/transcript/Timeline.tsx`.
- **do:**
  - Add a Timeline tab next to Transcript that renders one row per event: `iso-time | kind | source | json`.
  - Selectable range; "copy as markdown" button copies the selection in a token-efficient form.
  - Filter chips by event kind.
- **done-when:** in a real session, switching to Timeline shows every event in order; copy-as-markdown produces a paste-ready block.

### T21 — Collapsible + resizable panels
- **why:** user wants flexible layouts; some panels stay open all session, others fold.
- **scope:** `packages/web/src/views/layout.tsx`, `packages/web/src/components/ResizeHandle.tsx`, `packages/web/src/components/Sheet.tsx`, persist state to `localStorage`.
- **do:**
  - Sidebar, transcript, chat, DAG, resource panel each get a collapse toggle and a resize handle (preserve the doc-listener pointer pattern from known-bugs).
  - Persist sizes per breakpoint to localStorage; restore on mount.
- **done-when:** every panel can be collapsed and resized; refresh preserves layout; mobile breakpoint falls back to sheet behaviour.

### T22 — PWA: install, offline shell, push, button-density
- **why:** user wants buttons/popups instead of menus on mobile (lack of space). Install/offline/push exist as files but aren't mounted into the app.
- **scope:** `packages/web/src/pwa/*.ts`, `packages/web/src/App.tsx`, `packages/web/src/views/header.tsx`.
- **do:**
  - Mount `pwa/install.ts` (beforeinstallprompt → top-banner button), `pwa/offline.ts` (service worker registration + offline indicator), `pwa/push.ts` (subscribe button gated on user gesture, posts to `/api/push-subscribe`).
  - On mobile breakpoint, replace dense menus with stacked button rows and bottom sheets.
- **done-when:** Lighthouse PWA install prompt shows; subscribing to push results in a row in `push_subscriptions`; a server-emitted attention causes an OS notification.

### T23 — Live resource panel
- **why:** the resource monitor exists; the panel does not surface it usefully.
- **scope:** `packages/web/src/resource/Indicator.tsx`, `packages/web/src/resource/Panel.tsx`, `packages/web/src/store/resourceStore.ts`.
- **do:**
  - Indicator: small CPU/mem/loop-lag dot in header that reflects ResourceEvent.
  - Panel: 60s sparkline per metric, plus disk free, eventLoopLagMean.
  - Threshold colours from a single `severity()` helper.
- **done-when:** indicator turns yellow/red as the resource sampler reports >70%/>90%; panel shows recent history.

### T24 — Runtime override drawer (schema-driven)
- **why:** runtime overrides exist; web has no real surface to flip them.
- **scope:** `packages/web/src/runtime/Drawer.tsx`, `packages/web/src/runtime/autoForm.tsx`, `packages/engine/src/runtime/schema.ts`.
- **do:**
  - Engine returns the schema with each value tagged `live` (applies immediately) or `restart` (next boot).
  - Web autoForm renders inputs from the schema; PATCH on change; show the live/restart tag next to each.
  - Audit row written on every change.
- **done-when:** flipping `ciAutoFix` in the drawer takes effect without restart; flipping a `restart` field shows a banner.

---

## Phase 5 — DAG/ship depth

### T25 — DAG watchdogs + boot reconciliation
- **why:** today a DAG node session that dies mid-run leaves the DAG stuck.
- **scope:** `packages/engine/src/dag/scheduler.ts`, `packages/engine/src/dag/model.ts`.
- **do:**
  - Watchdog tick every 30s: any `ready` node whose session is `failed`/`cancelled` is moved to `failed`; any `running` node whose process is gone is restarted (bounded retries).
  - On boot, reconcile every non-terminal DAG (extends T14).
  - Operator commands: `dag.retry`, `dag.cancel`, `dag.force-land` typed in `Command`.
- **done-when:** killing a node session mid-run causes the DAG to mark `failed` within 30s; retry command spawns a fresh node session.

### T26 — DAG canvas: attention overlays + parent/child + viewport persistence
- **why:** canvas is functional but operator can't quickly see which node needs attention and how DAGs nest.
- **scope:** `packages/web/src/views/dagCanvas.tsx`.
- **do:**
  - Overlay chip on each node: `attention | failed | running | landed`.
  - Render parent-session edge to its DAG; allow drilldown to child DAG canvas.
  - Persist pan/zoom per `connectionId+dagId` in localStorage.
- **done-when:** a failing DAG visibly draws attention; reload restores viewport; double-click on parent jumps to child.

### T27 — Ship: plan→DAG creation + verify summary + boot reconcile
- **why:** ship coordinator persists stages but doesn't drive them off transcript content; verify stage shows nothing useful.
- **scope:** `packages/engine/src/ship/coordinator.ts`, `packages/engine/src/ship/stages.ts`, `packages/engine/src/completion/handlers/shipAdvance.ts`.
- **do:**
  - When `dag` stage transcript yields a parsed DAG (T09), create it and bind it to the ship session.
  - When all DAG nodes hit `landed`, advance to `verify`; verify stage emits a structured summary derived from DAG outcomes (PR list, readiness, CI).
  - Boot reconciliation re-arms ship stage based on persisted `shipStage` + DAG state.
- **done-when:** running a ship session end-to-end on a mock repo produces stage transitions, a real DAG, and a verify summary the operator can read.

---

## Phase 6 — Admission classes

### T28 — Reserve interactive capacity; cap autonomous work
- **why:** loops and DAG tasks can starve interactive sessions when capacity is constrained.
- **scope:** `packages/engine/src/sessions/registry.ts`, `packages/engine/src/loops/scheduler.ts`, `packages/engine/src/dag/scheduler.ts`, `packages/shared/src/runtime-config.ts`.
- **do:**
  - Define classes: `interactive | autonomous_loop | dag_task | background`.
  - Runtime config: total slots, reserved for `interactive`, hard cap per other class.
  - Spawn admission: deny non-interactive when no free non-reserved slots; reasons logged to audit.
- **done-when:** with `total=4, reservedInteractive=2, loopCap=2`, one interactive session and three loops cannot all run; admission denies the loop excess with a clear reason.

---

## Phase 7 — Memory review UX

### T29 — Memory review/search UI wired through MCP
- **why:** memory store + MCP exist; web review surface is thin.
- **scope:** `packages/web/src/memory/Drawer.tsx`, `packages/web/src/memory/list.tsx`, `packages/web/src/memory/edit.tsx`, `packages/web/src/memory/review.tsx`.
- **do:**
  - List with status filter (`pending|approved|rejected|superseded|pending_deletion`), repo-scope filter, full-text search box hitting `/api/memories?q=`.
  - Approve/reject/edit inline; `pending` count badge in the sidebar.
  - Realtime via `memory_updated` events.
- **done-when:** with T05 and T06 landed, an agent-proposed memory appears as `pending` in the drawer and the operator can approve it without leaving chat.

---

## Phase 8 — Regression suite

These tasks are higher leverage than usual because they prevent the parallel-session-revert pattern. Land them after the features they cover are real, not before.

### T30 — Mock-engine fixture
- **why:** tests should be able to spin up the engine in-process against an in-memory sqlite + mock provider, no docker, no port collisions.
- **scope:** `packages/engine/src/index.ts` (factory tightening), new `packages/engine/test/fixture/engine.ts`.
- **do:**
  - Fixture exposes `createTestEngine()` that returns `{engine, baseUrl, token, close()}` with an OS-allocated port.
  - All later regression tests use this fixture.
- **done-when:** `pnpm --filter @minions/engine run test` boots the fixture in <1s.

### T31 — SSE reconnect tests
- **why:** locks down T11/T12.
- **scope:** new `packages/engine/test/sse.test.ts`, may need a tiny eventsource helper.
- **do:**
  - Test: connect → emit 3 events → close → emit 5 → reconnect with `since` → expect 5 backfilled in order.
  - Test: ping every 25s; client receives within tolerance.
- **done-when:** both pass deterministically.

### T32 — Multi-connection isolation tests
- **scope:** `packages/web/src/store/...`, vitest or playwright unit harness.
- **do:** assert that with two connections, store reads keyed by connectionId never bleed.
- **done-when:** test fails before T13 lands and passes after.

### T33 — Chat lifecycle E2E
- **scope:** `packages/web/playwright/...` (force `MINIONS_PORT=8801` per known-bugs).
- **do:** create session → reply → inject mid-turn → image paste → restore checkpoint → stop. Snapshot transcript.
- **done-when:** runs green in CI.

### T34 — DAG/ship E2E
- **scope:** same playwright harness.
- **do:** spawn a ship session against a fixture repo; assert stage transitions, DAG creation, landed nodes, verify summary.
- **done-when:** green in CI; covers boot reconcile by killing/restarting the engine mid-run.

### T35 — REST/web type contract tests
- **scope:** `packages/shared/src/api.ts`, new `packages/shared/test/contract.test.ts`.
- **do:**
  - For each endpoint pair, assert that the engine route's input/output type names match shared exports and that web call sites import the same names.
  - Static: a script that greps for inline `fetch` body shapes and flags ones not derived from `@minions/shared`.
- **done-when:** running the script + tests on a clean main is green; intentionally mistyping a body fails it.

---

## Notes for the loop driver

- Run Phase 0 strictly before later phases; later tasks build on these guarantees.
- T15 (reply injection) is the user's explicit "crucial" feature — prioritize within Phase 3.
- T14 (resume on boot) is the user's explicit "redeploy and continue" requirement — ship Phase 2 in full before Phase 3.
- Don't dispatch any two tasks in parallel that share files. The collision matrix to watch:
  - `sessions/registry.ts` is touched by T01, T05, T08, T14, T15, T16, T28 — sequence them.
  - `chat/ChatSurface.tsx` is touched by T15, T17, T18 — sequence them.
  - `dag/scheduler.ts` is touched by T03 (proximate), T09, T14, T25, T28 — sequence them.
- For each task, use `references/dispatch-prompt-template.md` and copy the **scope** + **do** + **done-when** verbatim into the session prompt; add the standard "don't run pnpm dev / non-default ports / commit yourself" footer.
- Each task should land its own commit on `main` via the dogfood apply flow before the next dispatches.
