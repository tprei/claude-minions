# Verifiable loop implementation plan

## Goal

Make the verification loop executable against the current engine-port architecture, with deterministic gates for every feature in `docs/architecture.md`.

## Scope

1. Rewrite the truth inventory around `Workflow`, `TaskNode`, `GraphOperation`, supervisor rules, transitions, runtime diagnostics, and the current REST surface.
2. Add CI gates for typecheck, lint, package tests, disabled-rule scanning, and status/renderer exhaustiveness.
3. Wire runtime self-check endpoints: `/health/deep`, `/version`, `/metrics`, and `/doctor`.
4. Add periodic recovery scans for live engines.
5. Fix known regression gaps where probes expose root causes, starting with CI reset-on-green, GitHub 429 classification, push stale-info retry, and SQLite concurrency/PRAGMAs.
6. Extend smoke coverage through deterministic scenarios before adding broad fuzzing.

## Verification

- `pnpm run lint`
- `pnpm -r run typecheck`
- `MWF_HAS_GIT=1 pnpm -r run test`
- `pnpm --filter @minions/web run build`
- `pnpm --filter @minions/web run test:e2e`
- `pnpm --filter @minions/engine run smoke`
- `pnpm --filter @minions/engine run test:chaos`
- `pnpm --filter @minions/engine run dogfood:verify`
- `git diff --check`
