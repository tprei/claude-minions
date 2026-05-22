# DAG dispatch stacking

2026-05-22

## Problem

A workflow's `dependsOn` edges control task **ordering** (a task waits until each
dependency reaches a success status — `completed`/`pr-open`/`merged`) and supply
the dependency's artifacts to the agent as **prompt context**. They do **not**
base the dependent task's worktree on its dependency's code.

`SchedulerService.dispatchPending` → `RetryTaskService.run()` →
`workspace.create({ branch, resetBranch: true })` with no `baseRef`, so
`git worktree add -B <branch> <path> (baseRef ?? HEAD)` branches every task from
`HEAD` (the default branch). Because a dependency is "satisfied" at `pr-open`
(not merged), the default branch does not yet contain the dependency's commits.

Result: dependent tasks are cut from the base branch, never see their
dependencies' code, and re-implement overlapping areas. The PRs collide at land
time (e.g. `wf-mpfo6h9k-x4n67`: #44–#50 each rewrote `entry.tsx` and conflict).

## Fix

When dispatching a task that has dependencies, base its worktree on the
dependency branch so the agent builds on top of the accumulated stack.

- 0 deps → base on `HEAD` (unchanged).
- 1 dep → base on the dependency's branch.
- N deps → base on the **dominating dependency**: the dependency whose
  transitive `dependsOn` closure contains every other dependency (a
  linearizable join). If no dominating dependency exists, the parents are
  independent and need an octopus-merge base — surfaced as
  `unstackable_dependencies` for now (see Follow-ups).

The existing `RestackExecutor` already rebases descendants when a parent branch
moves (`rebase --onto newHead oldHead branch`); it assumes the descendant was
stacked on the parent. Dispatch-time stacking establishes that assumption — the
two together keep a prompted DAG landable with no manual intervention.

## Changes

- `application/stacking.ts` (new): `deriveBranch`, `transitiveDependencies`,
  `stackBaseRef`.
- `retry-task-service.ts`: compute `stackBaseRef(workflow, taskId)` and pass it
  as `baseRef` to `workspace.create`.
- `merge-service.ts`, `continue-task-service.ts`: import `deriveBranch` from
  `stacking.ts` (drop the local duplicates).
- Tests: `test/application/stacking.test.ts` (base resolution, dominating
  dependency, independent-parent error).

`continue-task-service` (resume, `resetBranch: false`) keeps the existing branch,
which the initial dispatch already based correctly — no base change needed there.

## Follow-ups (not in this change)

- Octopus-merge base for genuinely independent parents.
- `RestackExecutor` tracks a single primary parent; multi-parent restack-on-move
  needs the same dominating/merge treatment.
- Resolve the dependency branch from `origin/<branch>` (fetch) when the local
  ref is absent (e.g. after a fresh clone).
