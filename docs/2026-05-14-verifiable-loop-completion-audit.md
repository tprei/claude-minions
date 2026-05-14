# Verifiable loop completion audit

## Objective

Make the proposed verifiable loop pass for all features in `/home/prei/minions/claude-minions`.

## Success criteria

1. The architecture truth inventory matches the engine-port code.
2. Static, unit, integration, smoke, chaos, browser e2e, runtime self-check, and dogfood stages are implemented as executable gates.
3. Every named feature category in the proposal has at least one concrete gate.
4. Known regression probes from the proposal either pass as chaos probes or have an equivalent stronger test.
5. Scheduled CI runs the continuous stages and publishes dogfood artifacts.

## Prompt-to-artifact checklist

| Requirement | Evidence | Status |
| --- | --- | --- |
| Rewrite `docs/architecture.md` around `Workflow`, `TaskNode`, `GraphOperation`, current events, transitions, supervisor rules, REST, and feature table | `docs/architecture.md` feature table and verification loop | Covered |
| Remove stale sessions, DAG package, loops, variants, memory MCP, runtime overrides, and old command surfaces | `docs/architecture.md` removed concepts; `web/src/chat/slashCommands.ts`; `web/src/components/CommandPalette.actions.ts` | Covered |
| Remove or explicitly quarantine stale shared/web DTO exports for sessions, DAGs, memory, loops, screenshots, checkpoints, and runtime config | Stale shared DTO modules and `web/src/types.ts` removed; `shared/src/index.ts` now exports only current contract modules | Covered |
| CI typecheck, package tests, lint, disabled-rule scan | `.github/workflows/ci.yml`; `package.json`; `eslint.config.js`; `scripts/check-no-disabled-rules.mjs` | Covered |
| Add web and shared tests to CI | `MWF_HAS_GIT=1 pnpm -r run test` in CI | Covered |
| Status mapper exhaustiveness | `web/src/views/statusToVisual.ts`; `web/src/views/__tests__/statusToVisual.test.ts` | Covered |
| Transcript renderer exhaustiveness | `web/src/transcript/events/index.ts`; `web/src/transcript/events/index.test.tsx` | Covered |
| Web unit coverage for connections, hooks, PWA, util | `web/src/connections/store.test.ts`; `web/src/hooks/useFeature.test.tsx`; `web/src/pwa/haptics.test.ts`; `web/src/util/randomId.test.ts` | Covered |
| Shared contract tests for `WorkflowEvent` shapes | `shared/src/event.ts`; `shared/src/workflow-event.test.ts` exhaustive kind example matrix | Covered |
| Engine recovery missing cases | `engine/test/application/run-orchestrator.test.ts`; `engine/test/application/boot.test.ts`; `engine/test/application/recovery-runtime.test.ts` | Covered |
| Supervisor rule test per rule | `engine/test/supervisor/rules/*.test.ts` for `ci-exhausted`, `orchestrator-silent`, `merge-inconsistent`, `boot-recovery-failed`, `push-failures-spike` | Covered |
| Transition event payload and version increment for every transition | `engine/src/application/transitions.ts` `TRANSITION_KINDS`; `engine/test/events.test.ts` transition contract matrix | Covered |
| Smoke matrix for auto-merge, fail-then-fix, quality block, manual merge, conflict, complete-without-pr | `engine/scripts/smoke.ts`; `pnpm --filter @minions/engine run smoke` | Covered |
| Chaos probe: GitHub 429 in `findPRByHead` | `engine/test/chaos/regressions.chaos.test.ts` and completion dispatcher test | Covered |
| Chaos probe: stale push rejection fetch and retry | `engine/test/chaos/regressions.chaos.test.ts`; `engine/test/plugins/github/github-scm-plugin.test.ts` | Covered |
| Chaos probe: CI fail, continue, new head green | `engine/test/chaos/regressions.chaos.test.ts`; babysitter reset-on-green test | Covered |
| Chaos probe: two engines, one SQLite path | `engine/test/chaos/regressions.chaos.test.ts` | Covered |
| Chaos probe: SIGKILL after final before `complete-runtime` | `engine/test/chaos/regressions.chaos.test.ts` boot replay after post-final crash | Covered |
| Chaos probe: 300 worktrees bounded by `withTimeout` | `engine/test/chaos/regressions.chaos.test.ts`; `GitWorktreeWorkspaceBackend` `operationTimeoutMs` | Covered |
| Chaos probe: `tmux kill-server` mid-stream | `engine/test/chaos/regressions.chaos.test.ts` dead runtime probe recovery | Covered |
| Chaos probe: stuck `git fetch` releases per-repo lock via timeout | `engine/src/plugins/git/git-client.ts`; `engine/src/plugins/workspace/git-worktree-backend.ts`; git/worktree tests and chaos lock-release probe | Covered |
| Chaos probe: quota-exhausted provider backoff | `engine/src/application/scheduler-service.ts`; `engine/test/chaos/regressions.chaos.test.ts` identical-failure backoff probe | Covered |
| Browser e2e: connection URL | `web/tests-e2e/app.spec.ts` | Covered |
| Browser e2e: QR import | `web/tests-e2e/app.spec.ts` QR payload import flow | Covered |
| Browser e2e: SSE reconnect refetches `/workflows` | `web/tests-e2e/app.spec.ts`; `web/src/transport/__tests__/sseStatus.test.ts` | Covered |
| Browser e2e: snapshot cache offline replay | `web/tests-e2e/app.spec.ts` | Covered |
| Browser e2e: status renderer exhaustiveness | `web/tests-e2e/app.spec.ts` renders every `TaskExecutionStatus` x `TaskStackStatus`; `web/src/views/__tests__/statusToVisual.test.ts` | Covered |
| Browser e2e: slash registry contract | `web/tests-e2e/app.spec.ts`; `web/src/chat/__tests__/slashCommands.test.ts` | Covered |
| Browser e2e: pull-to-refresh threshold and haptics | `web/tests-e2e/app.spec.ts` | Covered |
| Runtime self-check endpoints | `engine/src/transport/server.ts`; `engine/test/transport/health.test.ts` | Covered |
| Runtime self-check doctor checks for SQLite WAL, busy timeout, tmux, GitHub, disk, dependency cache | `engine/src/engine.ts` `buildDoctorReport` | Covered |
| Periodic recovery scan | `engine/src/engine.ts` `recoveryScanIntervalMs` loop | Covered |
| Dogfood verify loop with real Claude CLI | `engine/scripts/dogfood.ts`; `engine/package.json` `dogfood:verify`; CI `dogfood` job; local report `/tmp/claude-minions-dogfood-report.json` terminalStatus `merged` | Covered |
| Dogfood artifact publication | CI `actions/upload-artifact@v4` for `dogfood-report.json` | Covered |

## Latest local verification

- `pnpm run lint`
- `pnpm -r run typecheck`
- `MWF_HAS_GIT=1 pnpm -r run test`
- `pnpm --filter @minions/web run build`
- `pnpm --filter @minions/web run test:e2e`
- `pnpm --filter @minions/engine run smoke`
- `pnpm --filter @minions/engine run test:chaos`
- `git diff --check`
- `MWF_DOGFOOD_TIMEOUT_MS=300000 MWF_DOGFOOD_REPORT=/tmp/claude-minions-dogfood-report.json MWF_DOGFOOD_KEEP_TMP=1 pnpm --filter @minions/engine run dogfood:verify`

## Completion decision

The loop is complete against the proposal. The current tree has executable gates for every stage, covers every named feature category, removes the stale shared/web pre-port contract surface, and passes the full local verification set listed above, including the current dogfood run with terminal status `merged` and no alerts.
