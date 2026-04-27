# claude-minions

A self-hostable, self-driving multi-agent coding orchestrator. One long-running engine spawns coding-agent CLIs in isolated git worktrees, persists their conversations, and exposes the whole machine over a small REST + SSE surface. A Vite-built PWA renders the live state and lets an operator drive the system. A separate sidecar process watches everything and proactively spawns sub-sessions to handle the issues it flags.

The whole thing dogfoods itself: every commit on the `main` history below `phase 4` was written by a session running through this engine.

## Layout

```
claude-minions/
  package.json                    pnpm workspaces, top-level scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.js                flat config, packages/*/src linted
  bin/engine.sh                   thin launcher (engine reads .env.local itself)
  Dockerfile                      multi-stage; bundles engine + built PWA + claude CLI
  docker-compose.yml              one service, exposes :8787, mounts .claude + secrets
  .github/workflows/ci.yml        typecheck + lint + engine tests + web build + e2e
  .githooks/pre-commit            staged eslint (inert under codex sandbox)
  docs/
    architecture.md               original wire-format and subsystem layout
    deploy.md                     mini-PC walkthrough including HTTPS via Caddy
  packages/
    shared/                       wire-format types — see "Wire format" below
    engine/                       long-running HTTP service (the orchestrator)
    web/                          single-page PWA (the operator console)
    sidecar/                      separate process: watcher + rules engine
```

## What the engine does

A single Node process (`packages/engine`) that:

1. Owns a workspace dir (default `./.dev-workspace`) containing
   - `engine.db` — SQLite (WAL) with the canonical schema
   - `repos.json` — bound repositories (id, label, remote, defaultBranch)
   - `.repos/<id>.git` — bare clone cache
   - `<session-slug>/` — per-session git worktree
   - `home/<provider>/` — agent CLI auth dir (mountable)
2. Exposes REST + SSE on `MINIONS_PORT` (default 8787) with bearer auth.
3. Spawns coding-agent subprocesses (`claude` CLI by default; `mock` for dev/CI), parses their NDJSON streaming output into typed transcript events, persists them, and broadcasts via SSE.
4. Wraps each session's worktree with: bare clone cache, hardlinked deps cache, asset injection (instructions / AGENTS.md / CLAUDE.md / `.cursor/rules/`).
5. Schedules DAG nodes, ship-pipeline stages, loops, and N-way variant + judge runs.
6. Drives the GitHub side: pushes branches via a GitHub App-minted installation token, opens PRs via `gh`, polls check runs, and squashes via `gh pr merge` when a session lands.
7. Restacks descendants on parent land; spawns a `rebase-resolver` session on conflict.
8. Boot-resumes any session whose status is `running` or `waiting_input` via the agent CLI's resume mechanism. Operator messages typed during downtime are persisted in a disk-backed reply queue and delivered exactly once on resume.

### Engine subsystems (one directory per subsystem under `packages/engine/src/`)

| dir | what it owns |
|---|---|
| `bus/` | in-process typed pub/sub (`EventBus`) |
| `ci/` | gh-pr-checks polling, fix-CI auto-spawn, askpass shim that injects the App token |
| `completion/` | dispatcher + handlers fired on session terminal events: digest, quality gate, auto-commit, etc. |
| `dag/` | DAG schema, scheduler, parser (extracts JSON DAG blocks from agent output), terminal handler |
| `digest/` | per-session summary at completion |
| `github/` | App auth (RS256 JWT minting via `node:crypto`, no JWT lib), installation token cache, REST helpers |
| `http/` | Fastify server, auth preHandler, SSE handler, route registry, individual route files |
| `intake/` | external task ingestion (idempotent on `(source, externalId)`) |
| `landing/` | push, ensurePR, `gh pr merge`, restack manager, stack PR comment |
| `loops/` | cron-style recurring sessions with backoff and slot reservations |
| `memory/` | memory CRUD + review workflow + MCP-style server + preamble injection |
| `providers/` | abstraction + `claude-code` (real) + `mock` (deterministic) |
| `push/` | web-push subscriptions + VAPID + per-attention notifier |
| `quality/` | per-repo quality gate runner, configurable command list |
| `readiness/` | composite merge readiness across PR + checks + reviews + quality + branch freshness |
| `resource/` | cgroup-aware cpu/mem + disk + event-loop-lag telemetry |
| `runtime/` | live-editable overrides with a schema (rendered in the PWA's runtime drawer) |
| `sessions/` | registry, transcript collector, reply queue, screenshots, diff, checkpoints |
| `ship/` | think → plan → dag → verify → done coordinator with per-session mutex |
| `stats/` | aggregated counts + Prometheus exposition |
| `store/` | sqlite open + numbered migrations + per-table repos |
| `variants/` | spawn N siblings, run extract → advocate → judge to pick a winner |
| `workspace/` | bare clone, worktree, deps cache, asset injector |

## What the PWA does

`packages/web` is a Vite + React 18 + Zustand + Tailwind PWA. Single-page, installable, multi-tenant (holds N engine connections, switches between them).

Views: list, kanban, DAG canvas (ReactFlow + dagre), staged ship pipeline. Chat surface as a resizable side panel (desktop) / bottom sheet (mobile) with tabs for transcript / diff / PR / checkpoints / screenshots / DAG status. Drawers for memory, runtime config (auto-rendered from the engine's schema), audit log, resource snapshots. PWA polish: service worker, install prompt, web-push opt-in, offline detection, theme toggle (light/dark/system via CSS variables), QR scanner for one-tap connection import.

The transcript renderer groups consecutive tool_call / tool_result events into collapsible blocks with kind icons + bold verb + content preview + status pill (the conductor.build pattern).

## What the sidecar does

`packages/sidecar` is a small standalone Node process that subscribes to the engine's REST + SSE and runs a rules engine over sessions, transcripts, and audit events. Five built-in rules:

- `stuckWaitingInput` — pokes sessions sitting in `waiting_input` for too long.
- `uncommittedCompleted` — backstops sessions that completed without committing their worktree changes.
- `failedCiNoFix` — spawns a fix-CI sub-session on PR check failures (parallel safety net to the engine's CI babysitter).
- `landReady` — logs (or auto-lands when `MINIONS_SIDECAR_AUTO_LAND=true`) sessions whose readiness is green.
- `dagStaleReady` — watchdog for DAG nodes that have been ready for too long without spawning.

Adding a rule: new file under `packages/sidecar/src/rules/`, add to `rules/index.ts`. Each rule is a `{ id, init?, onSessionUpdated?, onTranscriptEvent?, onAuditEvent?, tick? }`.

## Wire format

The only public contract between engine and PWA. See `packages/shared/src/`. Highlights:

- `Session` — slug, status, mode, ship_stage, repo+branch, parent/root, attention flags, quick actions, stats, PR summary.
- `TranscriptEvent` — eight kinds: user_message, turn_started, turn_completed, assistant_text, thinking, tool_call, tool_result, status. All carry `seq` for stable ordering.
- `DAG` / `DAGNode` — node statuses include `ci-pending`, `ci-failed`, `landed`, `rebasing`, `rebase-conflict`.
- `Command` — discriminated union of 15 operator commands: reply, stop, close, plan-action, ship-advance, land, retry-rebase, submit-feedback, force, retry, judge, split, stack, clean, done.
- `ServerEvent` — discriminated union of 14 SSE event kinds. Snapshot semantics: every frame carries the full object, the client replaces. No deltas.
- `Memory`, `Quality`, `Readiness`, `RuntimeConfig`, `Resource`, `Checkpoint`, `ExternalTask`, `LoopDefinition`, `Audit`, `Stats` — etc.

## REST + SSE surface

```
GET    /api/health                              liveness
GET    /api/version                             features list + repos
GET    /api/doctor                              aggregate diagnostics
GET    /api/sessions[?status=,mode=,q=,limit=,cursor=]   server-side filter + cursor pagination
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
POST   /api/commands                            discriminated Command union
POST   /api/messages                            convenience: reply if sessionSlug, else create
POST   /api/intake                              external task ingestion
GET    /api/intake
GET    /api/loops
POST   /api/loops
PATCH  /api/loops/:id
DELETE /api/loops/:id
GET    /api/stats /stats/modes /stats/recent
GET    /api/metrics                             prom-text
GET    /api/readiness/summary
GET    /api/audit/events?limit=
GET    /api/memories
POST   /api/memories
PATCH  /api/memories/:id
PATCH  /api/memories/:id/review
DELETE /api/memories/:id
GET    /api/config/runtime                      schema + values + effective
PATCH  /api/config/runtime
GET    /api/push/vapid-public-key
POST   /api/push-subscribe
DELETE /api/push-subscribe
GET    /api/events                              SSE; auth via ?token=
```

## Quick start

```bash
git clone https://github.com/tprei/claude-minions.git
cd claude-minions
pnpm install
pnpm --filter @minions/shared run build

cp .env.local.example .env.local                 # edit MINIONS_TOKEN
mkdir -p .dev-workspace
cat > .dev-workspace/repos.json <<'JSON'
[{"id":"self","label":"claude-minions","remote":"https://github.com/<you>/<your-repo>.git","defaultBranch":"main"}]
JSON

bin/engine.sh                                    # engine on :8787
pnpm --filter @minions/web run dev               # PWA on :5173
pnpm --filter @minions/sidecar run dev           # optional: watcher process

# Open http://localhost:5173/, add a connection (http://127.0.0.1:8787 + the token).
```

Common operations once running:

```bash
TOKEN=$(grep '^MINIONS_TOKEN=' .env.local | cut -d= -f2)

# Spawn a task session
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"...","mode":"task","repoId":"self","baseBranch":"main","prompt":"..."}' \
  http://127.0.0.1:8787/api/sessions

# List with filters
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/api/sessions?status=running&limit=20"

# Land a session: push branch + open PR + gh pr merge --squash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"land","sessionSlug":"<slug>","strategy":"squash"}' \
  http://127.0.0.1:8787/api/commands
```

## GitHub App setup

The engine prefers App auth (short-lived installation tokens, scoped permissions, GitHub-side merge through `gh pr merge`). Three env vars in `.env.local`:

```
MINIONS_GH_APP_ID=<Client ID, e.g. Iv23...>      # also accepts numeric App ID
MINIONS_GH_APP_PRIVATE_KEY=/abs/path/to/app.pem
MINIONS_GH_APP_INSTALLATION_ID=<numeric>
```

App permissions: Contents R/W, Pull requests R/W, Checks R, Metadata R, Actions R. No webhook needed for the current flow. When the env vars are unset the engine falls back to the host's `gh` CLI auth.

## Configuration

| Env var | What | Default |
|---|---|---|
| `MINIONS_TOKEN` | Bearer for REST + SSE | `changeme` |
| `MINIONS_HOST` | Bind | `0.0.0.0` |
| `MINIONS_PORT` | Listen | `8787` |
| `MINIONS_WORKSPACE` | sqlite + bare clones + worktrees | `./workspace` |
| `MINIONS_PROVIDER` | `claude-code` or `mock` | `mock` |
| `MINIONS_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `MINIONS_CORS_ORIGINS` | CSV of allowed origins | `http://localhost:5173` |
| `MINIONS_SERVE_WEB` | `true` to serve `MINIONS_WEB_DIST` from `/` | unset |
| `MINIONS_WEB_DIST` | Path to built PWA | unset |
| `MINIONS_VAPID_PUBLIC` / `_PRIVATE` / `_SUBJECT` | web-push (optional) | unset |
| `MINIONS_GH_APP_ID` / `_PRIVATE_KEY` / `_INSTALLATION_ID` | GitHub App (preferred) | unset |
| `GITHUB_TOKEN` | PAT fallback when App vars unset | unset |
| `MINIONS_LOOP_TICK_SEC` | Loop scheduler tick | `5` |
| `MINIONS_RESOURCE_SAMPLE_SEC` | Resource snapshot interval | `2` |
| `MINIONS_SSE_PING_SEC` | SSE keepalive | `25` |
| `MINIONS_LOOP_RESERVED_INTERACTIVE` | Slots reserved for operator-initiated sessions | `4` |

Plus `<workspace>/repos.json` for repo bindings (replaces the old `MINIONS_REPOS` env JSON).

Live overrides via `PATCH /api/config/runtime` (schema returned by `GET /api/config/runtime`):

| key | type | default |
|---|---|---|
| `dagMaxConcurrent` | number | 3 |
| `loopMaxTotal` | number | 20 |
| `loopReservedInteractive` | number | 4 |
| `ciAutoFix` | boolean | false |
| `quotaRetryBudget` | number | 3 |
| `memoryMcpEnabled` | boolean | true |
| `qualityTimeoutMs` | number | 300000 |
| `pushNotifyOnAttention` | boolean | true |
| `judgeRubricDefault` | string | (built-in) |
| `sseHeartbeatSec` | number | 25 |
| `rebaseAutoResolverEnabled` | boolean | true |
| `landingDefaultStrategy` | enum | `squash` |
| `autoCommitOnCompletion` | boolean | true |

## Deploy

`docs/deploy.md` walks through the mini-PC flow. tl;dr:

```bash
git clone https://github.com/tprei/claude-minions.git ~/minions
cd ~/minions
cp .env.local.example .env.deploy
$EDITOR .env.deploy   # set token, GH App vars (MINIONS_GH_APP_PRIVATE_KEY=/secrets/gh-app.pem)
mkdir -p data secrets
cp /path/to/your-gh-app.pem secrets/gh-app.pem && chmod 600 secrets/gh-app.pem
mkdir -p data/workspace
cat > data/workspace/repos.json <<'JSON'
[{"id":"self","label":"...","remote":"https://github.com/.../...","defaultBranch":"main"}]
JSON
docker compose up -d --build
```

Visit `http://<host>:8787/`, add a connection back to the same URL with your token.

## Testing

```bash
pnpm -r run typecheck                            # all packages
pnpm --filter @minions/engine run test           # 85+ node:test cases
pnpm lint                                        # eslint flat config
pnpm --filter @minions/web run e2e               # playwright e2e (boots engine on :8801)
```

CI runs all of these on every push and PR (`.github/workflows/ci.yml`). Playwright traces + reports are uploaded as artifacts on failure.

## Stack-agnostic notes

The reference implementation uses Node + TypeScript + Fastify + better-sqlite3 + simple-git + React 18, but nothing in the design requires that. Any stack with cheap subprocess spawning + streaming stdout, a typed pub/sub bus, a transactional row store, SSE or websocket fan-out, and a reactive UI will fit. The wire format (`packages/shared`) is small enough to re-implement either side independently as long as the event/command shapes stay stable.
