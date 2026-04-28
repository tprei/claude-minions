# New dogfood tasks — claude-minions correctness, isolation, and finish-the-job

Generated 2026-04-28 from a full repo audit: parallel review agents over the original `dogfood-tasks.md` task list (T01–T35) plus a separate code-review pass for issues outside that list. This doc tracks remaining gaps and adds new tasks for issues the original list didn't cover.

Same conventions as `dogfood-tasks.md`:
- **why** — one-line motivation
- **scope** — directories/files the agent may touch
- **do** — behaviour-level changes (not implementation prescriptions)
- **done-when** — observable criteria

Don't run two tasks in parallel that touch the same file. Stop the loop and surface issues whenever a task can't satisfy its done-when.

---

## Coverage of `dogfood-tasks.md`

| Task | Status | Note |
|---|---|---|
| T01 — completion dispatcher wired | ✅ DONE | `index.ts:109` wires `wireCompletionHandlers()`; dispatcher subscribes to `session_updated` terminal transitions; handlers run in order with audit logging on errors. |
| T02 — truthful `features[]` | ✅ DONE | `version/probes.ts` runs probes at boot; `/api/version` returns both `features` and `featuresPending`. |
| T03 — loops scheduled once | ✅ DONE | `loops/index.ts:272` guards against double-start; `reconcileOnBoot()` invoked at `:284`. |
| T04 — no silent claude→mock fallback | ❌ NOT_DONE | `providers/claudeCode.ts:255-258` and `:301-304` still silently substitute mock when CLI missing. **See T36.** |
| T05 — memory MCP wired into spawn | ⚠ PARTIAL | Config written and `--mcp-config` passed; bridge subprocess lifecycle and error surfacing are missing. **See T37.** |
| T06 — memory review contract | ✅ DONE | `MemoryReviewCommand` in shared, validated in route, exact shape sent from web. |
| T07 — variants single handler | ✅ DONE | One registration in `routes/index.ts`; shared types. |
| T08 — authed screenshots + capture | ✅ DONE | Path traversal rejected; capture on lifecycle events; auth via global preHandler. |
| T09 — DAG creation from transcript | ✅ DONE | `dag/index.ts:161-198` subscribes to `transcript_event` for `mode=ship && shipStage=dag` and creates DAG via `parseDagFromTranscript`. |
| T10 — ship stage advancement | ✅ DONE | Mutex-guarded `advanceLocked`; per-stage exit conditions; directive injection. |
| T11 — robust SSE | ✅ DONE | 25s pings, full-jitter backoff, visibility/online/pageshow reconnect, status pill. |
| T12 — transcript high-water reconciliation | ✅ DONE | Per-slug high-water tracked client-side; `?since=` backfill in seq order. |
| T13 — per-connection web stores | ✅ DONE | All stores keyed by `connId` via `byConnection` Map. |
| T14 — resume on boot | ⚠ PARTIAL | Sessions, reply queue, loops, DAG reconciled. Ship coordinator re-arm from persisted `shipStage` is not invoked at boot. **See T44.** |
| T15 — reply injection | ✅ DONE | But contract is at-least-once, not exactly-once as README claims. **See T38.** |
| T16 — image paste on create | ⚠ PARTIAL | Server enforces MIME and size; web does not enforce the 5-images-per-message cap. **See T55.** |
| T17 — image paste mid-conversation | ✅ DONE | Reuses upload pipeline; reply commands accept attachments. |
| T18 — failure-recovery footer | ✅ DONE | Status, readiness summary, Retry/Resume/Abort/Restore actions. |
| T19 — optimistic feedback | ⚠ PARTIAL | `optimistic.ts` exists but `registerIntent` has zero call sites. No 250ms delay, no rollback toast. **See T45.** |
| T20 — Timeline view | ✅ DONE | Tab + per-event row + range select + copy-as-markdown + filter chips. |
| T21 — collapsible/resizable panels | ⚠ PARTIAL | Only chat rail has full collapse/resize. Transcript, DAG canvas, resource panel lack inline toggles and persistent resize. **See T46.** |
| T22 — PWA install/offline/push | ⚠ PARTIAL | Hooks mounted but no explicit `navigator.serviceWorker.register` and no mobile button-density pass. **See T47.** |
| T23 — live resource panel | ✅ DONE | Header indicator, 60s sparklines, severity helper. |
| T24 — runtime override drawer | ⚠ PARTIAL | Schema-driven autoForm + live/restart tags + PATCH wired; audit row emission on change is not explicitly verified. **See T48 sub-bullet.** |
| T25 — DAG watchdogs + retry/cancel/force-land | ⚠ PARTIAL | Watchdog and commands wired; retries are unbounded and process-liveness is only inferred from terminal session status. **See T50.** |
| T26 — DAG canvas overlays/edges/viewport persist | ✅ DONE |  |
| T27 — ship plan→DAG + verify summary | ✅ DONE | Verify summary emitted; T09 wiring covers DAG creation. (Earlier audit incorrectly flagged this as blocked.) |
| T28 — admission classes | ✅ DONE | `sessions/admission.ts` classifies and gates. |
| T29 — memory review/search UI | ✅ DONE | Sidebar pending badge at `sidebar.tsx:74-192`; full-text + status + repo filters; realtime via `memory_updated`. |
| T30 — mock-engine fixture | ✅ DONE | `engine/test/fixture/engine.ts`. |
| T31 — SSE reconnect tests | ✅ DONE | `engine/test/sse.test.ts`. |
| T32 — multi-connection isolation tests | ⚠ PARTIAL | Engine-side test landed; web-side vitest unit tests deferred (no web test runner yet). **See T54.** |
| T33 — chat lifecycle E2E | ✅ DONE | `web/e2e/chat-lifecycle.spec.ts`. |
| T34 — DAG/ship E2E | ⚠ PARTIAL | Two paths skipped by design (mock provider can't emit fenced DAG; playwright `webServer` lifecycle can't restart engine). Unit-test coverage exists. Acceptable; not re-listed. |
| T35 — REST/web type contract tests | ✅ DONE | `shared/src/contract.test.ts`. |

**Headline:** ~29/35 fully done; 6 partial; 1 not done. The not-done one (T04 silent fallback) is the only correctness-critical regression — every other gap is finishing the work, not breaking trust.

The remaining tasks below are: (a) finishing the partials above, and (b) net-new findings the original list didn't cover.

---

## Phase 9 — Trust gaps (must precede further dogfooding)

These are the ones where the engine's behaviour silently disagrees with what the README/dogfood doc claim. Fix before running more autonomous loops on top.

### T36 — Remove silent claude→mock fallback (redo of T04)
- **why:** `providers/claudeCode.ts:255-258` and `:301-304` write a stderr line and call `mockProvider.spawn(opts)` when `claude` isn't on PATH. Operator sees a "running" session producing fake transcript and fake commits. The original T04 was marked done-when at "removing claude from PATH causes session create to fail with a clear 502, not spawn a mock" — the current code does spawn a mock.
- **scope:** `packages/engine/src/providers/claudeCode.ts`, `packages/engine/src/providers/registry.ts`, `packages/engine/src/version/probes.ts`.
- **do:**
  - In `claudeCodeProvider.spawn` and `.resume`, throw `EngineError("upstream", "claude CLI not found")` when `findClaudeBinary()` returns null. No fallback.
  - Cache the binary-path probe at boot and refresh it on `runtime` config change; expose result through the `/api/health` payload as a per-provider `degraded` entry.
  - Mock provider is only selected when `provider === "mock"` is explicitly set on the create body (already the case) or when `MINIONS_PROVIDER=mock` is set in env.
  - Add a unit test that, with `findClaudeBinary` stubbed to null, `spawn` rejects with the engine error and no child process is started.
- **done-when:** removing `claude` from `$PATH` makes `POST /api/sessions` return 502 with `error: "upstream"`; `/api/health` shows `{providers:{"claude-code":"degraded"}}`; no `mock` transcript ever appears for a session created without `provider:"mock"`.

### T37 — Memory MCP bridge: lifecycle, readiness probe, integration test
- **why:** T05 wired the config but the bridge subprocess (`mcpBridge.mjs`) runs as a child of the agent process with no liveness check, no error surfacing, and no test that an agent's `propose_memory` call actually lands a row. If the bridge is broken, the agent hangs silently.
- **scope:** `packages/engine/src/memory/mcpServer.ts`, `packages/engine/src/memory/mcpBridge.mjs` (or wherever the bridge entry lives), `packages/engine/src/sessions/registry.ts` (writeMcpConfig), `packages/engine/src/version/probes.ts`.
- **do:**
  - On `writeMcpConfig`, sanity-check that the bridge entry file is parseable JS / executable; if not, throw with a clear message instead of writing a config that will fail at agent runtime.
  - Strengthen the `memory-mcp` probe in `version/probes.ts` from "file exists" to "spawned subprocess responds to a single MCP `tools/list` round-trip in under 2s." Probe runs at boot and on runtime config change.
  - Integration test: run a mock provider variant that calls `propose_memory` over its stdio MCP channel; assert a `memories` row appears with `status=pending` within 5s.
- **done-when:** bridge file removed → `featuresPending` includes `"memory-mcp"` and session create still succeeds (only the propose path is unavailable); integration test in `packages/engine/test/` covers a real propose round-trip.

### T38 — Reply queue: exactly-once delivery contract
- **why:** README promises "exactly once on resume." Current implementation is at-least-once with a window where `handle.write` succeeds but `markDelivered` doesn't run (crash, broken pipe with delayed mark, etc.) — operator's message gets re-injected on next resume. Worse, if the write silently fails and the mark runs anyway, the message is lost.
- **scope:** `packages/engine/src/sessions/replyQueue.ts`, `packages/engine/src/sessions/registry.ts` (drain sites at `:488-492`, `:595-599`, `:718`).
- **do:**
  - Add a `delivered` state column with `pending | in_flight | delivered` (rename existing `delivered_at` accordingly).
  - Wrap the existing two-step (write + mark) in a tx: take a row from `pending` to `in_flight` in one statement (`UPDATE … SET state='in_flight' WHERE id=? AND state='pending'`), only mark `delivered` after the provider write returns successfully, and on engine crash boot re-checks any `in_flight` rows against provider `externalId` to decide redeliver vs treat as delivered.
  - Provider `handle.write` returns a Promise that resolves only when the write to stdin has been flushed (or rejects on `EPIPE`); the current fire-and-forget `write()` is the underlying issue.
  - Add a regression test that simulates: enqueue → write → kill engine before mark → restart → assert the message appears exactly once in the new session's transcript.
- **done-when:** kill -9 between write and mark on a mock-provider session results in exactly one delivery on resume; lost-write also redelivers exactly once; test asserts both.

### T39 — Slug-keyed mutex around session resume / spawn
- **why:** `resumeAllActive()` checks `this.handles.has(slug)` *before* `await provider.resume(...)` and only sets `handles.set(slug, …)` after the await. A second concurrent caller (boot resume + a runtime trigger, two re-entrant code paths) can pass the guard, both spawn provider processes, both set the handle — the second `set` orphans the first. Compounds T38: pending replies get double-delivered.
- **scope:** `packages/engine/src/sessions/registry.ts` (resume + spawn paths), `packages/engine/src/util/mutex.ts` (or wherever the existing per-slug mutex lives — used by ship coordinator).
- **do:**
  - Wrap the entire resume body for one slug in `ctx.mutex.run(slug, async () => …)`, matching the pattern the ship coordinator already uses.
  - Same treatment for spawn: from "row insert" through "handle.set" through "pendingAll drain", under the mutex.
  - Add a stress test: 50 parallel calls to resume the same slug — exactly one provider process spawned, exactly one set of replies delivered.
- **done-when:** stress test passes; orphaned-handle log line never observed; the mutex name shows up in audit on every resume/spawn.

### T40 — Per-route auth policy (replace global-skip allow-list)
- **why:** `http/server.ts:35-41` is an allow-list (`if url === "/api/events"` etc.) that skips global auth. New SSE-style routes need an entry; new private routes don't. The pattern is also exact-match (a trailing slash request bypasses the skip and gets the SSE route auth-checked twice). Token-via-`?token=` query is currently allowed for *every* route (`auth.ts:18-19`), so tokens leak into reverse-proxy access logs and `Referer` headers from non-SSE GETs.
- **scope:** `packages/engine/src/http/server.ts`, `packages/engine/src/http/auth.ts`, `packages/engine/src/http/routes/*.ts`.
- **do:**
  - Replace the global allow-list with a default-deny preHandler that requires header-only auth on every `/api/*` route, and an explicit per-route opt-in for `public` (health) or `query-token` (SSE only).
  - `extractBearerToken` accepts header by default; query-token path is gated by a per-route flag.
  - All non-SSE routes that today work with `?token=` stop accepting it; web client switches to `Authorization` header for REST.
  - Add a test matrix: each registered route × {no auth, header auth, query-token auth} → expected status.
- **done-when:** matrix test passes; `grep -n "?token=" packages/web/src/transport` returns only the SSE call site; production access logs contain no token-bearing URLs.

### T41 — Memory preamble: escape memory bodies before injection
- **why:** Memory bodies are operator- *and* agent-proposed (via the MCP server). They're concatenated into the system preamble for every session prompt. A body containing `\n\nIgnore prior instructions…` or formatting that mimics agent directives can shift behaviour for downstream sessions. The propose flow (T05) already lets agents add memories — this is reachable.
- **scope:** `packages/engine/src/memory/preamble.ts`, `packages/engine/src/memory/review.ts` (sanitization at write time vs render time).
- **do:**
  - Render memory bodies inside a fenced delimiter (`<memory id="…">…</memory>`) the agent's system prompt is instructed to treat as data, not instructions.
  - Strip / escape any closing delimiter the body itself contains.
  - Cap memory body length at a configurable max (default 2KB) — anything longer is rejected at propose time.
  - Add unit tests covering: body with closing delimiter, body with markdown headers, body with code fences, body at 2KB+1.
- **done-when:** an agent-proposed memory containing `</memory>\n# IGNORE EVERYTHING` is rendered safely (escaped) in a downstream session's preamble and does not change the agent's behaviour; tests cover the delimiter cases.

### T42 — Restack mutex (workspace ops behind per-slug lock)
- **why:** When parent session lands, restack iterates children and runs `git rebase` inside each child's worktree. If a child's session is still running, its provider subprocess may also be issuing git commands inside that worktree — race against `index.lock`, surfacing as either confused agent errors or a failed restack.
- **scope:** `packages/engine/src/landing/restack.ts`, `packages/engine/src/workspace/worktree.ts`, `packages/engine/src/util/mutex.ts`.
- **do:**
  - Take `ctx.mutex.run(childSlug, …)` around any worktree-mutating op in the restacker.
  - Same for `removeWorktree` and `addWorktree` paths used outside session lifecycle (e.g., admin endpoints).
  - Audit any other call site that touches a worktree directory while the session is active and wrap accordingly.
- **done-when:** test simulates a long-running mock session whose parent lands mid-turn — restack waits for the active turn to finish before rebasing; no `index.lock` failures in the audit log.

### T43 — Centralize transcript seq writer behind `nextSeq()` helper
- **why:** Six writers across `ship/coordinator.ts`, `digest/index.ts`, `dag/index.ts`, `sessions/transcriptCollector.ts`, `sessions/registry.ts` all use the `SELECT MAX(seq) + 1; INSERT` pattern. Today this is correct because better-sqlite3 is synchronous within one call, but adding any `await` between the SELECT and INSERT in any one of them silently breaks ordering and trips the `UNIQUE(session_slug, seq)` constraint.
- **scope:** all six writers above; `packages/engine/src/sessions/transcript.ts` (or new helper).
- **do:**
  - Add a single `insertTranscriptEvent(db, {slug, kind, body, …})` helper that does `INSERT … VALUES (?, ?, (SELECT COALESCE(MAX(seq),-1)+1 FROM transcript_events WHERE session_slug=?), …) RETURNING seq` in one statement.
  - Replace every existing site with the helper.
  - Delete the duplicated prepared statements.
- **done-when:** `grep -n "MAX(seq)" packages/engine/src` returns one match (the helper); existing tests still pass.

---

## Phase 10 — Finish what's started

### T44 — Ship coordinator boot reconciliation
- **why:** T14 left this gap. The ship row's `ship_stage` survives restart, but `ShipCoordinator` doesn't re-arm anything at boot — if the operator killed the engine while a session was waiting to advance from `dag` → `verify`, the advance never fires until the next terminal turn.
- **scope:** `packages/engine/src/ship/coordinator.ts`, `packages/engine/src/index.ts` (boot order), `packages/engine/src/ship/coordinator.test.ts`.
- **do:**
  - Add `ShipCoordinator.reconcileOnBoot()` that, for every ship session in non-terminal state, re-evaluates the current stage's exit conditions and, if met, advances under the mutex.
  - Call it from `createEngine()` after sessions resume but before HTTP listen.
  - Test: persist a ship session at `dag` stage with all DAG nodes already `landed` → restart engine → assert it advances to `verify` with a `verify_summary` event emitted.
- **done-when:** test passes; restart never leaves a ship session stuck behind already-met exit conditions.

### T45 — Wire optimistic dispatch into command call sites
- **why:** T19 done-when is "clicking Stop/Reply/Land mutates the visible state instantly, rolls back if the engine rejects." `optimistic.ts` exists with the right shape, but `registerIntent` has zero callers — `postCommand` doesn't use it. No 250ms pill-delay logic, no rollback toast.
- **scope:** `packages/web/src/store/optimistic.ts`, `packages/web/src/transport/rest.ts`, `packages/web/src/store/sessionStore.ts`, `packages/web/src/store/dagStore.ts`, `packages/web/src/chat/ChatSurface.tsx`, `packages/web/src/components/Toast.tsx` (or wherever toasts live).
- **do:**
  - Each mutating REST call (stop, reply, land, ship-advance, dag.retry, restore-checkpoint, etc.) goes through a single `dispatchCommand(intent, request)` helper that registers an optimistic store update keyed by `requestId`.
  - When the matching SSE event arrives the intent cancels; on 5s timeout the registered rollback runs and a toast surfaces.
  - "Sending…" pill on the affected card only renders if the round-trip exceeds 250ms (start a delayed render timer).
  - Bind each intent to the `connId` it was issued from (closes #51 below) — rollback no-ops if the operator switched connections.
- **done-when:** clicking Stop on a running session flips the status pill instantly; engine rejects → rolls back within 5s with a toast; switching connection mid-flight doesn't fire a rollback against the wrong store slice.

### T46 — Panels parity: collapse + resize for transcript, DAG canvas, resource
- **why:** T21 done-when says "every panel can be collapsed and resized; refresh preserves layout; mobile breakpoint falls back to sheet." Today only the chat rail has full collapse/resize via `panelLayout.ts`. Transcript, DAG canvas, and the resource panel render as fixed regions.
- **scope:** `packages/web/src/views/layout.tsx`, `packages/web/src/components/ResizeHandle.tsx`, `packages/web/src/components/Sheet.tsx`, `packages/web/src/views/dagCanvas.tsx`, `packages/web/src/resource/Panel.tsx`, `packages/web/src/transcript/Transcript.tsx`, `packages/web/src/store/panelLayout.ts`.
- **do:**
  - Extend `panelLayout` storage to cover transcript, dagCanvas, resource panels (collapsed boolean + size per breakpoint).
  - Each panel gets a header collapse toggle + a `ResizeHandle` (vertical or horizontal as appropriate).
  - Persist on change; restore on mount.
  - Mobile breakpoint: collapsed panels become bottom sheets (already the pattern for runtime/memory drawers).
- **done-when:** all four panels collapsible + resizable; refresh preserves; mobile shows sheets.

### T47 — Service worker registration + mobile button density
- **why:** T22 done-when names "Lighthouse PWA install prompt" and "stacked button rows on mobile." `pwa/offline.ts` assumes `navigator.serviceWorker.ready` resolves but no module explicitly calls `register()`; `vite-plugin-pwa autoUpdate` *does* inject this, but failure modes (registration error, SW unsupported) are not surfaced. Mobile menu density work was never done.
- **scope:** `packages/web/src/pwa/offline.ts`, `packages/web/src/pwa/install.ts`, `packages/web/src/App.tsx`, `packages/web/src/views/header.tsx`, `packages/web/vite.config.ts`.
- **do:**
  - Add explicit `navigator.serviceWorker.register(…)` (or verify the plugin's injected registration runs, and surface its error if it fails) with a top-banner fallback message.
  - Add `skipWaiting: true, clientsClaim: true` to the workbox config and a "new version available, click to reload" UX so a redeployed engine doesn't leave operators on stale JS.
  - At `sm` breakpoint, replace dense menu rows with stacked button rows; primary actions become bottom-sheet entries.
- **done-when:** Lighthouse PWA install prompt fires; redeploy → operator sees a reload banner within 30s of the new SW activating; mobile breakpoint shows stacked buttons not a kebab menu.

### T48 — Error UX for write-path APIs (memory propose, runtime patch, command post)
- **why:** Several `await api.post(...)` call sites have no try/catch. A 4xx/5xx leaves the UI in a half-submitted state with no banner. Memory drawer's "propose new" is the clearest example, runtime drawer PATCH likely has the same shape, and per T24 the audit row on runtime change is also unverified.
- **scope:** `packages/web/src/memory/Drawer.tsx`, `packages/web/src/runtime/Drawer.tsx`, `packages/web/src/runtime/autoForm.tsx`, `packages/web/src/transport/rest.ts`, `packages/web/src/components/Banner.tsx` (or equivalent), `packages/engine/src/runtime/index.ts` (audit emit on PATCH).
- **do:**
  - Wrap every write-path call in a try/catch; surface a structured banner with the engine's `error` + `message`; keep the form populated for retry.
  - Add a single `useApiMutation` hook that handles the loading/error/success branches consistently, and migrate all writers to it.
  - Engine: emit `audit_event` with kind `runtime.override` on every successful runtime PATCH, including the field name + old/new values (do not log secret-typed values).
- **done-when:** stubbing the engine to 500 on memory propose / runtime PATCH shows a banner, keeps form state, and lets the operator retry; runtime PATCH emits an audit row visible in `/api/audit`.

### T49 — Sidecar: `failedCiNoFix` clears spawn record on PR re-open / CI re-run
- **why:** The rule keeps an in-memory `Set` of slugs it's already spawned a fix-CI child for. The set is never cleared, so if the same PR's CI fails again later (re-run, force-push, re-open), the rule no-ops. The `landReady` rule has a 5min window for the same shape — `failedCiNoFix` should too.
- **scope:** `packages/sidecar/src/rules/failedCiNoFix.ts`.
- **do:**
  - Replace the boolean set with a Map keyed by slug, value = `{lastSpawnedAt}`.
  - Re-spawn allowed if the latest CI failure is newer than `lastSpawnedAt + cooldown` (default 5min, configurable).
  - On `pr_state` transition to `closed`/`merged`, drop the entry.
- **done-when:** simulated CI re-fail 10min after first spawn results in a second fix-CI child; same failure within cooldown does not.

### T50 — DAG retry budget + process-liveness signal
- **why:** T25 done-when names "bounded retries." Current `dag.retry` resets node to `pending` indefinitely. Watchdog also only marks a node `failed` when its session row hits a terminal state — a provider process that crashed without writing a terminal status row leaves the node `running` until the 30s tick *and* until the engine notices the session is dead.
- **scope:** `packages/engine/src/dag/scheduler.ts`, `packages/engine/src/dag/model.ts` (or wherever node row shape lives), `packages/shared/src/dag.ts`, `packages/engine/src/sessions/registry.ts` (process-exit hook to update session row).
- **do:**
  - Add `retry_count` and `max_retries` (default 3) to the DAG node row. `dag.retry` increments and rejects past the cap with a typed error.
  - On every provider `handle.waitForExit`, registry already updates session status — make sure the DAG watchdog reads that update path (not just polling) by wiring a bus subscription so node failures land within ~1s instead of ~30s.
  - Operator can still force a retry past the cap via a `dag.force-retry` command (audited).
- **done-when:** retry test caps at 3; force-retry works; killing a session's process flips its DAG node to failed within 2s in a fixture.

### T51 — Connection-scoped optimistic intents
- **why:** Folded into T45 as a sub-bullet. Listed separately so it's findable: `optimistic.ts:17` is a module-level `Map<requestId, Entry>` not partitioned by connection. If the operator switches connections during a 5s timeout window, the rollback fires against whatever store state exists then.
- **scope:** `packages/web/src/store/optimistic.ts`.
- **do:** see T45.
- **done-when:** see T45.

### T52 — `attachConnection` dispose hygiene
- **why:** `connectionState.ts:23-30` writes to `useVersionStore` after `await getVersion(conn)` with no `disposed` check, leaving a version-store entry for a connection that's been removed. Minor ghost-state.
- **scope:** `packages/web/src/store/connectionState.ts`.
- **do:**
  - Thread an `AbortController` (or a `disposed` ref) through every `await` in `init()`; bail before any store write if disposed.
  - Same treatment for any other awaited write inside the lifecycle.
- **done-when:** removing a connection while its initial fetch is in-flight leaves no entries in any store.

### T53 — Web image attachment 5-cap on the client
- **why:** T16 done-when implies "max 5 per message." Server enforces per-upload size + MIME but doesn't enforce a per-message count. Web should reject the 6th attachment in the picker/paste handler with a tiny inline message.
- **scope:** `packages/web/src/chat/attachments.tsx`, `packages/web/src/chat/ChatSurface.tsx`.
- **do:** drop attachments beyond 5 and surface "max 5 images per message"; same rule in initial-prompt and reply paths.
- **done-when:** pasting 7 images into the input results in 5 attached + a single inline notice; submit goes through.

### T54 — Web vitest harness + per-store isolation tests
- **why:** T32 deferred web-side store-isolation tests because there was no web test runner. The `optimistic.ts` TODO and `sse.ts` "regression coverage … lives in T31" comment both implicitly want the same harness.
- **scope:** `packages/web/package.json` (`"test": "echo skip"` today), `packages/web/vitest.config.ts` (new), `packages/web/src/store/*.test.ts` (new).
- **do:**
  - Add vitest with jsdom; wire `pnpm --filter @minions/web run test`.
  - Tests: store isolation across two `connId`s, optimistic registerIntent + cancel + timeout + rollback, transcript merge-by-seq dedup, SSE high-water backfill (against a fake EventSource).
- **done-when:** `pnpm test` runs vitest in `web` (no more `echo skip`); all four test groups pass; CI picks them up.

---

## Notes for the loop driver

- T36, T38, T39, T40 are correctness/security must-fix — sequence them first, ahead of any feature work.
- T36 should run before T37 since the MCP integration test depends on a real (or honestly-faked) provider.
- T45 + T51 are one task — listed twice for indexability. Do them together.
- Same-file collisions to watch:
  - `packages/engine/src/sessions/registry.ts` — T36, T38, T39, T50.
  - `packages/engine/src/http/server.ts` + `http/auth.ts` — T40 only.
  - `packages/web/src/store/optimistic.ts` — T45, T51, T54.
  - `packages/web/src/views/layout.tsx` + `panelLayout.ts` — T46.
  - `packages/sidecar/src/rules/` — T49 standalone.
- Each task should land its own commit on `main` via the dogfood apply flow before the next dispatches. Per the `feedback_orchestrator_agent_commits` memory: orchestrator must close the commit loop, prompts alone aren't enough.
- Per the `feedback_apply_diffs_not_files` memory: when applying changes from agent worktrees back to `main`, apply diffs not whole files — agent worktrees branch from stale main.
