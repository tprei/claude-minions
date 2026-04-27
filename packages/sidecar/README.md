# @minions/sidecar

A small node process that runs alongside the engine and watches it for issues
the engine itself didn't handle. Subscribes to the engine's REST + SSE,
inspects sessions, transcripts, and audit events, and proactively spawns or
nudges sessions to handle them. Self-healing: failed CI, stuck sessions,
untouched DAG nodes, and uncommitted completions all get noticed.

## What it does

The sidecar wires a `SidecarClient` (REST + SSE) to a `RulesEngine` that
dispatches events to a configurable set of named `Rule`s. Each rule decides
whether to act — by posting a command, creating a session, or just logging.
Rule errors are isolated; one bad rule never crashes the process.

Built-in rules:

- `stuckWaitingInput` — sessions sitting in `waiting_input` for more than 10
  minutes get a polite reply asking them to wrap up.
- `uncommittedCompleted` — backstop for the auto-commit handler. If a session
  completes with a dirty worktree, force `autoCommitOnCompletion=true`.
- `failedCiNoFix` — when a session has an open PR with `attention.kind ===
  'ci_failed'` and no `fix-ci` child session, spawn one.
- `landReady` — when a completed session with a ready PR hasn't been landed,
  log a nudge (or auto-land if `MINIONS_SIDECAR_AUTO_LAND=true`).
- `dagStaleReady` — watchdog that warns when a DAG node sits in `ready` for
  more than 60s without a session being spawned for it.

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `MINIONS_ENGINE_URL` | `http://127.0.0.1:8787` | Engine base URL |
| `MINIONS_TOKEN` | required | Bearer token (same one the engine uses) |
| `SIDECAR_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SIDECAR_RULES` | `all` | Comma-separated rule ids, or `all` |
| `MINIONS_SIDECAR_AUTO_LAND` | unset | Set to `true` to auto-land ready PRs |

## Run

```bash
pnpm --filter @minions/sidecar dev
# or, in production
pnpm --filter @minions/sidecar build
MINIONS_TOKEN=... node packages/sidecar/dist/cli.js
```

Run only some rules:

```bash
SIDECAR_RULES=stuckWaitingInput,landReady pnpm --filter @minions/sidecar dev
```
