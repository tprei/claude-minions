# Architecture

This document is the current contract for `claude-minions` after the engine port. It describes the code that exists now: workflows, task nodes, graph operations, the Hono engine, SQLite persistence, supervisor alerts, and the PWA client.

## Repo layout

```
claude-minions/
├── package.json
├── pnpm-workspace.yaml
├── eslint.config.js
├── .github/workflows/ci.yml
├── docs/
│   └── architecture.md
└── packages/
    ├── shared/
    │   ├── package.json
    │   └── src/
    │       api.ts doctor.ts version.ts transcript.ts push.ts ...
    ├── engine/
    │   ├── scripts/smoke.ts
    │   ├── src/
    │   │   ├── application/
    │   │   │   boot.ts commands.ts transitions.ts scheduler-service.ts
    │   │   │   run-orchestrator.ts recovery.ts recovery-service.ts
    │   │   │   merge-service.ts ci-babysitter-service.ts
    │   │   │   quality-gate-service.ts local-finalize-service.ts
    │   │   ├── domain/
    │   │   │   workflow.ts types.ts events.ts runs.ts errors.ts
    │   │   ├── persistence/
    │   │   │   schema.ts sqlite-repo.ts sqlite-subscription-repo.ts subscriber-hub.ts
    │   │   ├── plugins/
    │   │   │   git/ github/ providers/ quality/ runners/ tmux/ workspace/
    │   │   ├── supervisor/
    │   │   │   rules/ alert-repo.ts audit-repo.ts supervisor.ts scan-loop.ts
    │   │   ├── transport/
    │   │   │   server.ts validators.ts errors.ts
    │   │   ├── engine.ts
    │   │   └── main.ts
    │   └── test/
    │       fixtures/ integration/ application/ transport/ supervisor/ ...
    └── web/
        ├── src/
        │   ├── chat/ components/ connections/ hooks/ markdown/ pwa/
        │   ├── routing/ store/ transcript/ transport/ util/ views/
        │   ├── App.tsx
        │   └── main.tsx
        └── vitest.config.ts
```

## Runtime model

The engine owns a `Workflow` aggregate. A workflow contains `TaskNode` records in `graph`, recoverable `GraphOperation` records in `operations`, a scheduling policy, and an optimistic concurrency `version`.

Tasks have two independent status axes:

| Type | Literals |
| --- | --- |
| `TaskExecutionStatus` | `pending`, `ready`, `running`, `completed`, `finalizing`, `quality-pending`, `ci-pending`, `pr-open`, `merged`, `failed`, `cancelled`, `needs-review` |
| `TaskStackStatus` | `clean`, `restack-pending`, `restacking`, `restack-conflict`, `stale-artifacts` |
| `WorkflowStatus` | `active`, `completed`, `failed`, `cancelled` |
| `GraphOperationKind` | `restack` |
| `GraphOperationStatus` | `pending`, `running`, `completed`, `conflict`, `failed` |

`SchedulerService` watches workflow events and dispatches ready tasks through `RetryTaskService` or `ContinueTaskService`. `RunOrchestrator` starts a runtime session, attaches provider output, persists transcript events, and applies lifecycle transitions. `CompletionDispatcher`, `QualityGateService`, `CIBabysitterService`, `MergeService`, `LandWorkflowService`, and `LocalFinalizeService` move completed tasks through quality checks, pull requests, CI, merge, or local finalize paths.

## Workflow events

Durable events are persisted in SQLite with monotonically increasing per-workflow cursors. Transient events use cursor `0` and are delivered to live subscribers without advancing replay state.

| Event kind | Durable | Payload |
| --- | --- | --- |
| `task-transitioned` | yes | task id, transition kind, previous and next execution/stack status, task version |
| `graph-operation-changed` | yes | operation id, operation kind, previous status, next status |
| `run-started` | yes | run id, task id, attempt, runtime session id, provider/runtime type |
| `run-ended` | yes | run id, task id, attempt, terminal reason |
| `workflow-status-changed` | yes | previous status, next status |
| `provider-event` | no | task id, run id, provider transcript event |
| `merge-phase` | no | task id, merge phase, phase status, optional error |
| `ci-poll-result` | no | task id, PR number, head SHA, overall status, checks |

SSE is exposed at `GET /workflows/:id/events`. Clients can resume with `Last-Event-ID` or `?since=`. Durable frames include an SSE id. Transient frames omit an id so the browser does not advance `Last-Event-ID` past the durable cursor.

## Transitions

`application/transitions.ts` is the only place that mutates task execution status. Every transition increments the task version; saving the workflow increments the workflow version and produces derived events.

| Transition | Allowed from | Result |
| --- | --- | --- |
| `mark-ready` | `pending` | `ready` |
| `mark-running` | `ready`, `needs-review`, `pr-open` | `running`, appends a run, records session/workspace |
| `update-run` | `running` | patches provider session ref or output offset |
| `complete-runtime` | `running` | `completed`, closes run as `completed` |
| `start-finalization` | `completed` | `finalizing` |
| `open-review` | `finalizing` | `pr-open` |
| `start-quality-gate` | `completed`, `finalizing` | `quality-pending` |
| `complete-quality-gate` | `quality-pending` | `finalizing` or `needs-review` |
| `start-ci-gate` | `pr-open` | `ci-pending` |
| `complete-ci-gate` | `ci-pending` | `pr-open` |
| `merge-task` | `pr-open` | `merged` |
| `complete-without-pr` | `finalizing` | `merged` |
| `merge-conflict` | `pr-open`, `finalizing`, `ci-pending` | `needs-review` |
| `cancel-task` | `pending`, `ready`, `running`, `finalizing`, `quality-pending`, `ci-pending`, `needs-review` | `cancelled` |
| `recover-task` | `ready`, `running`, `quality-pending`, `ci-pending` | `pending` or `needs-review`, clears session |
| `mark-interrupted` | `running` | `needs-review`, clears session |
| `fail-task` | `pending`, `ready`, `running`, `finalizing`, `quality-pending`, `ci-pending` | `failed` |

## Persistence

`SQLiteWorkflowRepository` stores workflow blobs, durable workflow events, idempotency records, transcripts, push subscriptions, audit events, alerts, and alert subscriptions in one SQLite file. The repository applies PRAGMAs on open, prepares all statements once, and wraps workflow saves in a transaction.

Important invariants:

- `workflows.version` must match `incoming.version - 1` on update.
- event cursors are assigned inside the save transaction.
- recovery idempotency keys prevent double-dispatch after restart.
- transient events never write to `workflow_events`.
- `listRecoverable()` returns non-completed workflows plus completed workflows with non-terminal graph operations.

## Recovery

Boot recovery runs once during `createEngine()`. Periodic recovery runs against recoverable workflows while the engine is live. Recovery plans come from `application/recovery.ts`; execution lives in `application/recovery-service.ts`.

Recovery action kinds:

| Action | Behavior |
| --- | --- |
| `recover-task` | transition stale ready/running/gate tasks to pending or needs-review |
| `interrupt-task` | transition dead runtime sessions to needs-review |
| `stop-runtime` | stop mismatched runtime session, then cancel task |
| `probe-gate` | synthesize failed quality/CI artifacts for stale gates |
| `operator-review` | no automatic mutation |
| `resume-graph-operation` | resume pending/running restack operation through `RestackExecutor` |

`session_mismatch` during recovery is swallowed because another actor already moved the task. Other domain errors surface.

## Supervisor

The supervisor has a log sink, audit projector, alert repository, alert subscription repository, notification sender, and periodic scan loop.

Rules:

| Rule | Signal |
| --- | --- |
| `ci-exhausted` | CI attempt cap or exhausted CI repair loop |
| `orchestrator-silent` | running task has not produced progress within the rule window |
| `merge-inconsistent` | GitHub merge succeeded but internal transition failed |
| `boot-recovery-failed` | boot recovery reports failures |
| `push-failures-spike` | push sender failures spike within the observation window |

Audit routes are exposed at `GET /audit/events` and `GET /audit/workflows/:id`. Alert routes are exposed at `GET /alerts`, `POST /alerts/subscribe`, and `DELETE /alerts/subscribe`.

## REST surface

The engine exposes unprefixed routes from `transport/server.ts`:

| Route | Purpose |
| --- | --- |
| `GET /health` | shallow liveness |
| `GET /health/deep` | runtime self-check summary |
| `GET /version` | API/build/provider/repo/feature metadata |
| `GET /metrics` | Prometheus text metrics |
| `GET /doctor` | operator diagnostics |
| `POST /workflows` | create workflow |
| `POST /workflows/plan` | create workflow spec from prompt |
| `GET /workflows` | list active workflows, or completed with `?include=completed` |
| `GET /workflows/:id` | get workflow |
| `DELETE /workflows/:id` | delete workflow |
| `POST /commands` | apply command or invoke command service |
| `POST /workflows/:id/tasks/:taskId/merge` | merge task PR |
| `GET /workflows/:id/events` | SSE workflow events |
| `GET /workflows/:id/runs/:runId/transcript` | persisted provider transcript |
| `GET /push/vapid-public-key` | push public key |
| `POST /push/subscribe` | upsert workflow push subscription |
| `DELETE /push/subscribe` | remove workflow push subscription |
| `GET /audit/events` | audit event list |
| `GET /audit/workflows/:id` | audit event list by workflow |
| `GET /alerts` | alert list |
| `POST /alerts/subscribe` | upsert alert push subscription |
| `DELETE /alerts/subscribe` | remove alert push subscription |

## Feature table

Every user-visible feature row must have a code owner and a gate. A feature in code without a row, or a row without code, fails the truth inventory.

| Feature | Code owner | Gate |
| --- | --- | --- |
| Workflow create/list/get/delete | `engine/src/transport/server.ts`, `engine/src/domain/workflow.ts` | transport tests, smoke matrix |
| Workflow planning | `engine/src/application/planner-service.ts` | planner tests, `/workflows/plan` tests |
| Task transitions and workflow OCC | `engine/src/application/transitions.ts`, `engine/src/application/commands.ts` | transition tests, SSE tests |
| Scheduler concurrency and claim checks | `engine/src/application/scheduler-service.ts`, `engine/src/application/scheduler.ts` | scheduler tests, integration tests |
| Provider orchestration and transcripts | `engine/src/application/run-orchestrator.ts`, provider plugins | orchestrator tests, transcript tests |
| Pi provider plugin (opt-in via `MWF_PROVIDER=pi`) | `engine/src/plugins/providers/pi.ts` | Pi provider tests |
| Recovery boot and periodic scan | `engine/src/application/boot.ts`, `engine/src/application/recovery*.ts` | recovery tests, runtime self-check tests |
| Restack graph operation | `engine/src/application/restack*.ts` | restack tests, integration tests |
| Quality gates | `engine/src/application/quality-gate-service.ts`, quality plugins | quality tests, smoke matrix |
| GitHub PR creation and merge | `engine/src/application/merge-service.ts`, GitHub SCM plugin | merge tests, chaos probes |
| CI babysitting and auto-merge | `engine/src/application/ci-babysitter-service.ts` | babysitter tests, smoke matrix, chaos probes |
| Local finalize without PR | `engine/src/application/local-finalize-service.ts` | local finalize tests, smoke matrix |
| Push notifications | `engine/src/application/push-service.ts`, push routes | push tests, `/metrics` and key endpoint tests |
| Supervisor audit and alerts | `engine/src/supervisor/**` | supervisor rule tests, runtime metrics |
| Observability logging | `engine/src/observability/**` | observability tests |
| PWA connection management | `web/src/connections/**`, `web/src/transport/**` | web unit tests, browser e2e |
| PWA snapshot cache and offline replay | `web/src/transport/snapshotCache.ts`, PWA modules | web unit tests, browser e2e |
| PWA task graph and status rendering | `web/src/views/**`, `web/src/store/**` | exhaustive status tests, browser e2e |
| PWA transcript rendering | `web/src/transcript/**` | exhaustive renderer tests |
| Slash command registry | `web/src/chat/slashCommands.ts`, command routes | registry contract tests |
| Voice input | `web/src/chat/voice.ts` | web unit tests, browser e2e |
| Runtime diagnostics | `engine/src/transport/server.ts`, `shared/src/doctor.ts`, `shared/src/version.ts` | transport tests, `/doctor` |

## Removed engine-port concepts

The following pre-port modules and features are not part of the current architecture: sessions registry, reply queue, DAG package, ship stage coordinator, loop scheduler, variants judge, memory MCP, resource monitor, screenshots, checkpoints, runtime-overrides PATCH, and `CommandPalette` commands that target those removed APIs. New work must not reintroduce compatibility shims for these concepts.

## Verification loop

The loop is ordered so each stage gates the next:

1. Truth inventory: this document and the feature table match code.
2. Static gates: typecheck, lint, disabled-rule scan, exhaustive status and renderer tests.
3. Fast unit: engine, web, shared, and sidecar package tests.
4. Engine integration: real SQLite/git where needed, stub provider/runtime/quality.
5. Full-stack smoke matrix: deterministic HTTP create-to-finalize paths.
6. Chaos probes: known regression injections for GitHub 429, push reject, CI reset-on-green, two-engine SQLite, and runtime recovery.
7. Browser e2e: Playwright against a deterministic fixture engine.
8. Runtime self-checks: `/health/deep`, `/version`, `/metrics`, `/doctor`, periodic recovery.
9. Dogfood verify loop: scheduled fixture repo run with the real provider CLI.
