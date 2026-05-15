# claude-minions

A self-hostable, self-driving multi-agent coding orchestrator. One long-running engine spawns coding-agent CLIs in isolated git worktrees, persists their conversations, and exposes the whole machine over a small REST + SSE surface. A Vite-built PWA renders the live state and lets an operator drive the system.

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
  .github/workflows/ci.yml        typecheck + engine tests + web build + e2e
  .githooks/pre-commit            staged eslint (inert under codex sandbox)
  docs/
    architecture.md               original wire-format and subsystem layout
    deploy.md                     mini-PC walkthrough including HTTPS via Caddy
  packages/
    shared/                       HTTP wire-format types (sessions, transcript events, commands)
    engine/                       long-running HTTP service (the orchestrator)
    web/                          single-page PWA (the operator console)
```

## What the engine does

A single Node process (`packages/engine`) that:

1. Owns a workspace dir (default `./.dev-workspace`) containing
   - `engine.db` — SQLite (WAL) with the canonical schema
   - `repos.json` — bound repositories (id, label, remote, defaultBranch)
   - `.repos/<id>.git` — bare clone cache
   - `<session-slug>/` — per-session git worktree
   - `home/<provider>/` — agent CLI auth dir (mountable)
2. Exposes REST + SSE on `MWF_PORT` (default 3000; set to 8787 in production) with bearer auth.
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

cp .env.local.example .env.local                 # edit MWF_TOKEN and MWF_DB_PATH

bin/engine.sh                                    # engine on :3000 (MWF_PORT)
pnpm --filter @minions/web run dev               # PWA on :5173

# Open http://localhost:5173/, add a connection (http://127.0.0.1:3000 + the token).
```

Common operations once running:

```bash
TOKEN=$(grep '^MWF_TOKEN=' .env.local | cut -d= -f2)

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

## GitHub setup

Set in `.env.local`:

```
MWF_GITHUB_TOKEN=<personal access token or GitHub App installation token>
MWF_GITHUB_REPO_OWNER=<owner>
MWF_GITHUB_REPO_NAME=<repo>
MWF_GITHUB_BASE_BRANCH=main   # optional, defaults to main
```

## Configuration

| Env var | What | Default |
|---|---|---|
| `MWF_TOKEN` | Bearer for REST + SSE | required |
| `MWF_HOST` | Bind address | `0.0.0.0` |
| `MWF_PORT` | Listen port | `3000` |
| `MWF_DB_PATH` | SQLite database path | required |
| `MWF_DATA_DIR` | tmux sessions + log dir | optional |
| `MWF_WORKSPACE_ROOT` | git worktree root | optional |
| `MWF_REPO_PATH` | single-repo mode: path to a local repo | optional |
| `MWF_PROVIDER` | `claude-code`, `codex`, or `pi` | `claude-code` |
| `MWF_PI_MODEL` | Pi model id (used when `MWF_PROVIDER=pi`) | `openai-codex/gpt-5.5` |
| `MWF_PI_REASONING` | Pi reasoning depth, one of `off` / `minimal` / `low` / `medium` / `high` / `xhigh` | `xhigh` |
| `MWF_PI_AGENT_DIR` | Pi agent home dir | `~/.pi/agent` |
| `MWF_PI_SESSION_DIR` | Pi session store dir | `<agentDir>/sessions/minions` |
| `MWF_PI_TOOLS` | Override the Pi tools allowlist (comma-separated) | optional |
| `MWF_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `MWF_PWA_DIR` | Path to built PWA (serves from `/`) | optional |
| `MWF_VAPID_PUBLIC_KEY` / `MWF_VAPID_PRIVATE_KEY` / `MWF_VAPID_SUBJECT` | web-push (optional) | unset |
| `MWF_GITHUB_TOKEN` | GitHub PAT or App token | optional |
| `MWF_GITHUB_REPO_OWNER` / `MWF_GITHUB_REPO_NAME` | Target repo | optional |
| `MWF_GITHUB_BASE_BRANCH` | Default base branch | `main` |

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
pnpm --filter @minions/web run e2e               # playwright e2e (boots engine on :8801)
```

CI runs all of these on every push and PR (`.github/workflows/ci.yml`). Playwright traces + reports are uploaded as artifacts on failure.

## Stack-agnostic notes

The reference implementation uses Node + TypeScript + Fastify + better-sqlite3 + simple-git + React 18, but nothing in the design requires that. Any stack with cheap subprocess spawning + streaming stdout, a typed pub/sub bus, a transactional row store, SSE or websocket fan-out, and a reactive UI will fit. The wire format (`packages/shared`) is small enough to re-implement either side independently as long as the event/command shapes stay stable.
