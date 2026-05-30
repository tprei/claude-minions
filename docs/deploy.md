# Deploying claude-minions on a mini PC

One container, one port, one volume. Engine serves `/api/*` and the built PWA on `/`.

For unattended overnight runs and supervisor setup, see [docs/deploy/supervisor.md](deploy/supervisor.md).

## Prereqs on the host

- Docker + Compose (Docker Desktop or `docker.io` / `docker-ce`).
- A GitHub App created on github.com with: Contents R/W, Pull requests R/W, Checks R, Metadata R, Actions R. Installed on the repos you want to operate on.
- Your `claude` CLI logged in (or an `ANTHROPIC_API_KEY`) if you plan to keep the default `claude-code` provider. In the deploy compose path, Claude auth lives under `./data/home/.claude`; run `docker exec -it minions claude /login` once after first boot if needed.
- Optional, only if you want to run the Codex provider: a host-side `codex` CLI logged in. See [Codex](#codex) below.
- Optional, only if you want to run the Pi provider: a host-side `pi` CLI logged in to ChatGPT Codex. See [Pi + ChatGPT Codex](#pi--chatgpt-codex) below.

## First-time setup

```bash
git clone https://github.com/tprei/claude-minions.git ~/minions
cd ~/minions

cp .env.local.example .env.deploy
$EDITOR .env.deploy
```

Set in `.env.deploy`:

```
MWF_TOKEN=<a long random secret>
MWF_SITE_TOKEN_AUTH=1
MWF_HOST=0.0.0.0
MWF_PORT=8787
MWF_DB_PATH=/data/engine.db
MWF_DATA_DIR=/data/engine
MINION_UID=<your host uid>
MINION_GID=<your host gid>

MWF_GITHUB_TOKEN=<GitHub personal access token or App token>
MWF_GITHUB_REPO_OWNER=<owner>
MWF_GITHUB_REPO_NAME=<repo>
```

Drop the GitHub App private key into the secrets dir:

```bash
mkdir -p ./secrets ./data
cp /path/to/your-gh-app.pem ./secrets/gh-app.pem
chmod 600 ./secrets/gh-app.pem
```

If you plan to reuse host-side provider auth through `~/.codex` or `~/.pi`, set `MINION_UID` and `MINION_GID` to the host account that owns those directories. On Linux, `id -u` and `id -g` give you the right values.

Bring it up:

```bash
docker compose up -d --build
docker compose logs -f engine
```

Open the PWA on your laptop: `http://<mini-pc-lan-ip>:8787/`. In the connection picker, add `http://<mini-pc-lan-ip>:8787` with the token from `.env.deploy`.
If `MWF_SITE_TOKEN_AUTH=1`, the first page load shows a token prompt. Enter `MWF_TOKEN` once to unlock the browser session. After that, same-origin connections can leave the bearer token blank and rely on the access cookie, or you can still reuse `MWF_TOKEN` explicitly.

## Updates

```bash
cd ~/minions
git pull
docker compose up -d --build
```

The workspace + sqlite live under `./data`; they survive rebuilds. To wipe state, `docker compose down && rm -rf ./data && docker compose up -d`.

## Optional: HTTPS via Caddy

If the mini PC is reachable from the internet:

```yaml
# add to docker-compose.yml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
volumes:
  caddy_data:
```

```caddy
# Caddyfile
minions.your-domain.com {
  reverse_proxy engine:8787
}
```

Caddy auto-provisions LetsEncrypt. Update `MWF_CORS_ORIGINS=https://minions.your-domain.com` in `.env.deploy`, restart.

## Codex

The engine ships with a native `codex` provider. The deploy image now includes the Codex CLI, and the compose file bind-mounts `~/.codex` from the host into the container so the in-container agent reuses the same auth state.

### 1. Install + log in on the host

```bash
npm i -g @openai/codex@0.135.0
codex login
codex login status
test -s ~/.codex/auth.json && echo "ok"
```

### 2. Flip the engine to Codex

In `.env.deploy`:

```
MWF_PROVIDER=codex
```

Then:

```bash
docker compose up -d --build
docker compose exec engine codex --version
docker compose exec engine codex login status
curl -s -H "Authorization: Bearer <MWF_TOKEN>" http://localhost:8787/version | jq .provider
```

## Pi + ChatGPT Codex

The engine ships with an optional `pi` provider that drives the [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) CLI against OpenAI Codex with ChatGPT Plus/Pro subscription auth (no API key). Auth lives on the host and the container reuses it through a bind mount.

Codex through a ChatGPT subscription is governed by the OpenAI Codex terms; long-running unattended agents are within the spirit of the product but you are still responsible for staying within the rate caps and the [OpenAI Codex usage policy](https://platform.openai.com/docs/guides/codex). Pi documents the same caveat in its [provider docs](https://github.com/earendil-works/pi-coding-agent#providers).

### 1. Install + log in on the host

The container can't drive an interactive `/login` flow itself (it has no TTY and the OAuth redirect needs a real browser), so do this on the host first:

```bash
npm i -g @earendil-works/pi-coding-agent@0.74.0
pi
# inside the pi REPL:
/login
# pick "ChatGPT Plus/Pro (Codex)" and finish the browser flow.
# quit pi when done.
```

Confirm the auth blob landed:

```bash
test -s ~/.pi/agent/auth.json && echo "ok"
```

### 2. Flip the engine to Pi

In `.env.deploy`:

```
MWF_PROVIDER=pi
# Optional overrides — leave unset to take the defaults from packages/engine/src/main.ts
# MWF_PI_MODEL=openai-codex/gpt-5.5
# MWF_PI_REASONING=xhigh
# MWF_PI_AGENT_DIR=/data/home/.pi/agent
# MWF_PI_SESSION_DIR=/data/home/.pi/agent/sessions/minions
# MWF_PI_TOOLS=read,write,edit,bash,grep,find,ls
```

Then:

```bash
docker compose up -d --build
docker compose exec engine pi --version            # ≥ 0.74.0
docker compose exec engine ls -l /data/home/.pi/agent/auth.json
curl -s http://localhost:8787/api/version | jq .providers   # includes "pi"
```

The bind mount of `~/.pi` is intentionally writable: Pi rotates the Codex access/refresh tokens inside `auth.json`, and a read-only mount would silently break the refresh after the first expiry.

If you ever need to re-auth, run `pi` on the host (not in the container) and `/login` again; the container picks it up immediately on the next session because both sides point at the same file.

## Health + diagnostics

- `GET /api/health` — basic liveness
- `GET /api/doctor` — health + version + session/memory/resource snapshot in one call
- `GET /api/version` — features list + repos
- `docker compose logs -f engine` — structured JSON logs
- `docker compose exec engine sqlite3 /data/workspace/engine.db .tables` — peek at state

## Resource sizing

- Idle: < 100 MB RAM, near-zero CPU.
- Per active session: ~100–300 MB while claude is mid-turn (mostly the spawned subprocess), drops back when idle. Plan ~1.5 GB free RAM for 4 concurrent sessions.
- Disk: bare clones + worktrees + sqlite. Maybe 1–2 GB per repo for typical projects.
