# Deploying claude-minions on a mini PC

One container, one port, one volume. Engine serves `/api/*` and the built PWA on `/`.

> For unattended overnight runs and supervisor setup, see [docs/deploy/supervisor.md](deploy/supervisor.md).

## Prereqs on the host

- Docker + Compose (Docker Desktop or `docker.io` / `docker-ce`).
- A GitHub App created on github.com with: Contents R/W, Pull requests R/W, Checks R, Metadata R, Actions R. Installed on the repos you want to operate on.
- Your `claude` CLI logged in (or an `ANTHROPIC_API_KEY`). The compose file mounts `~/.claude` from the host into the container so the in-container claude reuses your auth.

## First-time setup

```bash
git clone https://github.com/tprei/claude-minions.git ~/minions
cd ~/minions

cp .env.local.example .env.deploy
$EDITOR .env.deploy
```

Set in `.env.deploy`:

```
MINIONS_TOKEN=<a long random secret>
MINIONS_HOST=0.0.0.0
MINIONS_PORT=8787
MINIONS_REPOS='[{"id":"self","label":"claude-minions","remote":"https://github.com/<owner>/<repo>.git","defaultBranch":"main"}]'

MINIONS_GH_APP_ID=<Client ID>
MINIONS_GH_APP_PRIVATE_KEY=/secrets/gh-app.pem
MINIONS_GH_APP_INSTALLATION_ID=<Installation ID>

MINIONS_CORS_ORIGINS=https://minions.<your-domain>,http://<mini-pc-lan-ip>:8787
```

Drop the GitHub App private key into the secrets dir:

```bash
mkdir -p ./secrets ./data
cp /path/to/your-gh-app.pem ./secrets/gh-app.pem
chmod 600 ./secrets/gh-app.pem
```

Bring it up:

```bash
docker compose up -d --build
docker compose logs -f engine
```

Open the PWA on your laptop: `http://<mini-pc-lan-ip>:8787/`. In the connection picker, add `http://<mini-pc-lan-ip>:8787` with the token from `.env.deploy`.

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

Caddy auto-provisions LetsEncrypt. Update `MINIONS_CORS_ORIGINS=https://minions.your-domain.com` in `.env.deploy`, restart.

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
