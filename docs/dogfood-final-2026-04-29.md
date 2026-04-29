# Dogfood final — 2026-04-29

End-state of the multi-batch dogfood drive started after the operator's two original complaints (stage:think edits, ignored injected reply).

## Live verification (final probe q1gldsh2yn)

- Tagged-reply probe: operator reply queued mid-session, agent re-resumes and reads the operator text on its next turn. ✅ delivery
- Turn numbering: original `HELLO` at turn=1, resumed assistant_text at turn=2. ✅ #10 fixed
- Read-only stage probe (earlier session y0mifvjt4h): mode:think asked to Edit refused with "Plan mode is active". Worktree diff empty. ✅ stage:think enforced
- §9 mode/stage and reply-injection gates have all run live and passed.

One nuance worth deciding on (logged as task #28): the wrapper `[Operator reply]: ...` triggers the agent's prompt-injection caution and it sometimes declines to act on operator replies it considers ambiguous. T38 + #10 ensure the bytes reach the agent; whether to add a trust marker is an operator-policy choice.

## Commits landed (newest first, since the foundation work began)

| commit | what |
|---|---|
| `28a3ae9` | #10 turn numbering: continueWithQueuedReplies bumps turn counter |
| `0636528` | U23 reapplied: real QrImportModal in picker + ThemeToggle from pwa/ in header |
| `a408f52` | T57 attachment safety + U21 slash dispatcher (ChatSurface props) + U23 picker/header |
| `a93c86f` | T55 token leak fix + T62 reviewDecision + U19 loops + U20 audit + U22 variants/entrypoints UI |
| `668c1cd` | T58 DAG landing readiness + T60 variants count + T61 CI false-green + #12 T41 REST + transcript wrap opt-in + T63 session delete |
| `8f38a32` | T56 env defaults + T59 DAG terminal + T36 probes degraded + T37 memory MCP probe + #8 mobile sidebar Sheet |
| `9c0a916` | T38 reply-queue exactly-once + #11 outer chat tablist a11y |
| `cbddd28` | docs: dogfood progress snapshot |
| `f68158b` | T45+T51 optimistic dispatch + T47 PWA SW + mobile density |
| `09c6a85` | T36 (no silent claude→mock fallback) + T46-followup transcript wrapper |
| `e76d0f2` | T46 panels parity (partial) |
| `f0d1c12` | T44 ship coordinator boot reconciliation |
| `e2db81c` | T52 connectionState dispose + T54 web vitest harness |
| `21ad860` | salvage: T42 restack + T48 error UX + doctor per-check + a11y tabs |
| `766e847` | fix(stage): use --permission-mode plan |
| `8117a0f` | fix(stage): drop --dangerously-skip-permissions + sidecar test wiring |
| `c2f60df` | fix: reply-injection + per-route auth + memory preamble escape + sidecar cooldown |

## All operator-tracked tasks: state

| # | task | state |
|---|---|---|
| 1 | Diagnose stage:think edits | ✅ |
| 2 | Diagnose injected reply | ✅ |
| 3 | Dogfood core engine features | ✅ |
| 4 | Dogfood UI tasks U01-U18 | ✅ |
| 5 | Process docs/new-dogfood-tasks.md (T36-T54) | ✅ |
| 6 | Sidecar test script | ✅ |
| 7 | Surface tabs role=tab | ✅ |
| 8 | Mobile sidebar Sheet | ✅ |
| 9 | Doctor per-check rows | ✅ |
| 10 | Turn numbering | ✅ |
| 11 | Outer chat surface tabs | ✅ |
| 12 | T41 REST 2KB cap | ✅ |
| 13 | T55 token leak (CRITICAL) | ✅ |
| 14 | T56 env defaults | ✅ |
| 15 | T57 attachment traversal | ✅ |
| 16 | T58 DAG landing | ✅ |
| 17 | T59 DAG terminal | ✅ |
| 18 | T60 variants count | ✅ |
| 19 | T61 CI false-green | ✅ |
| 20 | T62 reviewDecision | ✅ |
| 21 | T63 session delete | ✅ |
| 22 | U19 loops view | ✅ |
| 23 | U20 audit drawer | ✅ |
| 24 | U21 slash dispatcher | ✅ (ChatSurface props + 1 handler shipped; remaining slash bodies route through the new prop API and dispatcher; further full-coverage e2e deferred) |
| 25 | U22 variants/entrypoints UI | ✅ |
| 26 | U23 QR + theme | ✅ |
| 27 | T46-followup transcript wrap | ✅ |
| 28 | Operator reply trust marker | 🆕 logged for op decision |

## Process-improvement memories saved this drive

- `feedback_dogfood_verification_gates.md` — never skip §9 mode/stage and reply-injection probes.
- `feedback_dogfood_research_via_think.md` — prefer engine `mode:think` for research over Explore sub-agents.
- `feedback_readonly_via_no_skip_permissions.md` — superseded by `--permission-mode plan` finding.
- `feedback_dispatch_quota_aware.md` — quota signature: `status: failed`, turns 1-4, `assistant_text` quoting reset window.
- `feedback_bare_origin_local.md` — repoint bare clone's `origin` to local working tree to defeat the per-spawn force-fetch that wipes local commits.

## Engine-level lessons learned in flight (not memory-worthy but worth capturing here)

- Cp'ing engine source while sessions are in flight triggers tsx watch reload → engine restart → in-flight session deaths with "No deferred tool marker found". Always stop engine before applying batched changes; restart after committing.
- 3-way merging conflict markers into a tsx-watched file IS the same trap; resolve markers before tsx detects the change, or stop engine first.
- Stale-base salvage requires `git -C $WT diff HEAD~1..HEAD` (committed) or `git diff main` (uncommitted) + 3-way apply, never whole-file cp on files that recent main commits also touched.
- Bare clone `origin` defaulting to GitHub remote is the dominant stale-base cause; the engine's per-spawn force-fetch from that origin overwrites the bare's local main back to whatever GitHub has. Repointed once via `git remote set-url origin /home/prei/minions/claude-minions`; documented in `feedback_bare_origin_local.md`.

## Open follow-ups (not blocking)

- Task #28: operator reply prompt-injection wrapper UX
- T46 full panels e2e (transcript wrapper opt-in shipped; remaining panels not e2e-covered)
- T43 transcript seq centralization (deferred — high conflict surface)
