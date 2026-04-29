# Dogfood progress — 2026-04-29 (overnight session)

Hard stop hit at ~07:55 BST: Anthropic API quota exhausted. Reset is at 1:10 BST (next 24h window). All in-flight engine sessions died with quota messages; no more dispatches will succeed until the reset.

## What landed on `main`

| commit | scope | sessions |
|---|---|---|
| `c2f60df` | reply-injection fix + per-route auth (T40) + memory preamble escape (T41) + sidecar cooldown (T49) | 34zg6b7jo5, 8j9xsen4du, lxx45iwka1, id2ya5nr03 |
| `8117a0f` | stage:think `allowWriteTools` plumbing + READ_ONLY_STAGES set + sidecar test wiring | ljxeb4wn6v, 58wg50x31d |
| `766e847` | stage:think correctness fix — `--permission-mode plan` instead of dropping `--dangerously-skip-permissions` | direct edit (verification probe driven) |
| `21ad860` | salvage batch: T42 restack mutex + T48 error UX + U16 doctor per-check rows + a11y tablist | x8wi2efe31, o4elrezpea, cxalfmr81q, ioxh64cisc |
| `e2db81c` | T52 connectionState dispose hygiene + T54 web vitest harness | 9whqlxovr1, zsmccio39g |
| `f0d1c12` | T44 ship coordinator boot reconciliation + reply-drain test stub fix | udb4kf90ri |
| `e76d0f2` | T46 panels parity (partial: resource Panel + dagCanvas + panelLayout) | hknodpyp47 |
| `09c6a85` | T36 no silent claude→mock fallback (minimal) + T46-followup transcript wrapper preserves a11y | qssjh73lod, hv6bj06vld |
| `f68158b` | T45+T51 optimistic dispatch with conn scoping + T47 PWA SW + UpdateBanner + mobile header density | aiqq49fd0a, hk0v5vw3rp |

Foundation correctness verified live:
- §9 tagged-reply echo probe (`reply-probe-1777414627`): operator reply reached agent's next turn via `additionalPrompt`. ✅
- §9 read-only diff probe: `mode:think` session asked to Edit refused with "Plan mode is active". Worktree diff empty. ✅

## Operator-reported tasks resolved

- **stage:think allowing edits** — fixed via `--permission-mode plan`; live probe passes
- **injected reply ignored by agent** — fixed via `additionalPrompt` on next provider.spawn/resume + `continueWithQueuedReplies` helper; live tagged-echo passes
- **#6 sidecar test script** — wired
- **#7 surface tabs role=tab** — landed with arrow-key nav + e2e
- **#9 doctor per-check rows** — 8 named probes (provider-auth, github-auth, repo-state, worktree-health, dependency-cache, mcp-availability, push-config, sidecar-status)

## Tasks deferred (need re-dispatch when quota resets)

| task | reason |
|---|---|
| **T36 probes.ts extension** (per-provider degraded state) | stale-base 3-way collided with the just-landed `runDoctorChecks`; deferred |
| **T37 memory MCP bridge readiness probe + integration test** | quota |
| **T38 reply queue exactly-once** (`claim/confirm/release`) | quota; first dispatch's stale-base salvage reverted reply-fix's `reply()` so was reverted entirely |
| **T39 resume mutex** (per-slug guard around resume body) | not yet dispatched (was queued behind T38 on registry.ts) |
| **T43 transcript seq centralization** | not yet dispatched (high-conflict on registry.ts) |
| **T46 panels parity** — transcript outer wrapper landed; resource Panel/dagCanvas/panelLayout landed; full parity audit + e2e still pending | partial |
| **T50 DAG retry budget + process-liveness** | quota; conflicts with T38/T39 on registry.ts |
| **T53 web image attachment 5-cap** | quota |
| **#8 mobile sidebar slide-over Sheet** | quota |
| **#10 turn numbering: resumed turn keeps same number** | not yet dispatched |

## Operator pain points encountered (process notes)

1. **Stale-base hazard is the dominant failure mode.** Every dispatched worktree branched from `5c62402f` (the engine-boot SHA) regardless of how many times I refreshed `.dev-workspace/.repos/self.git`. The bare clone IS up-to-date after fetch, but the worktree's local `main` ref freezes at creation time. So `git diff main..HEAD` from the worktree always shows my recent commits as inverted reverts. Mitigation: always extract delta as `git -C $WT diff HEAD~1..HEAD` (when agent committed) or `git -C $WT diff main` and 3-way apply (when uncommitted). Whole-file `cp` only safe when the file hasn't changed in any commit since the worktree's base SHA.

2. **Engine crashes on `<<<<<<<` markers.** Twice during this session, applying a 3-way merge that produced conflict markers caused tsx watch to hot-reload the file, esbuild choked, the engine died. **All in-flight sessions died with the engine.** Lesson: stop the engine before doing 3-way merges that may produce conflicts; restart after resolving.

3. **Engine restart kills in-flight sessions.** Restarts during dispatch produced `status: failed turns=0` for every running session. Confirmed lesson from the SKILL hazard table.

4. **Quota exhaustion masquerades as "failed"** with low turn counts (1-4) and an `assistant_text` message naming the reset window. Save as memory (`feedback_dispatch_quota_aware.md`) so future loops detect it before dispatching the next wave.

5. **Sidecar test script** was a placeholder (`echo 'no tests'`) — fixed in this batch. Many other packages may have similar gaps; an audit task would be worth dispatching.

## Live UI snapshot at end of session

- All 5 main views render at 1440×900 with 0 console errors: List, Kanban, DAG, Ship, Doctor.
- Doctor shows 8 per-check rows (U16 PARTIAL → SHIPPED).
- Ship board shows aggregate columns.
- Kanban shows running/completed/failed lanes with 100+ sessions.
- Mobile (390×844) sidebar still overlaps chat (#8 not landed yet).

## To resume on quota reset

1. Re-dispatch in this order, sequencing on `packages/engine/src/sessions/registry.ts`:
   - T38 (with the explicit "do NOT modify reply() body" constraint that was added to the latest dispatch prompt)
   - T39 resume mutex
   - T50 DAG retry budget
   - #10 turn numbering

2. Web batch (parallel-safe with engine):
   - T53 image cap
   - #8 mobile sidebar Sheet
   - T46 panels parity audit + e2e

3. Standalone:
   - T36 probes.ts extension (per-provider degraded state, paired with /api/health update)
   - T37 memory MCP bridge probe + integration test
   - T43 transcript seq centralization (last because of conflict surface)

## Memory entries added this session

- `feedback_dogfood_verification_gates.md` — never skip §9 mode/stage and reply-injection probes
- `feedback_dogfood_research_via_think.md` — prefer engine `mode:think` for research
- `feedback_readonly_via_no_skip_permissions.md` — superseded by `--permission-mode plan` finding (corrected in MEMORY.md)
- `feedback_dispatch_quota_aware.md` — detect quota exhaustion before next batch
