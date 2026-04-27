# claude-minions

A self-hostable, self-driving multi-agent coding orchestrator: engine + installable PWA.

## Layout

```
packages/
  shared/      — wire-format types (session, transcript, dag, commands, sse events, ...)
  engine/      — long-running HTTP service: REST + SSE, agent subprocess orchestration
  web/         — single-page PWA: connections, transcripts, DAG canvas, chat
```

## Quick start

```bash
pnpm install
pnpm build                         # build shared types first
pnpm dev:engine                    # http://localhost:8787
pnpm dev:web                       # http://localhost:5173
# or both together:
pnpm dev
```

Engine env (defaults shown):

```
MINIONS_PORT=8787
MINIONS_HOST=0.0.0.0
MINIONS_TOKEN=changeme               # bearer token
MINIONS_CORS_ORIGINS=http://localhost:5173
MINIONS_WORKSPACE=./workspace
MINIONS_PROVIDER=claude-code         # or "mock"
MINIONS_VAPID_PUBLIC=
MINIONS_VAPID_PRIVATE=
MINIONS_VAPID_SUBJECT=mailto:ops@example.com
```

## Wire format (summary)

- HTTP REST + JSON for commands and reads, bearer auth.
- Server-sent events for the live stream, query-param auth.
- Snapshots, not deltas: each event carries enough context to render from cold.

See `packages/shared/src` for the full type surface.
