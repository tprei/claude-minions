# Unattended runs and supervisor setup

This runbook covers leaving the engine running unattended — overnight on a mini PC, on a home server, or anywhere you want the process to stay up across crashes and reboots. Two deployment paths are supported: bare-metal (Node + a shell supervisor) and Docker (compose with `restart: unless-stopped`).

## Overview

Pick the path that matches how you want to operate the box:

- **Bare-metal** runs the engine directly on the host with `scripts/supervise-engine.sh` as a foreground supervisor. Pair it with `nohup` for a quick session, or systemd for a reboot-safe install. Best when you want the engine close to the host (direct access to `~/.claude`, host paths, native filesystem performance) and you're comfortable managing Node and pnpm yourself.
- **Docker** runs the same engine inside the published image with compose handling restarts. Best when you want isolation from the host, predictable upgrades via `docker compose up -d --build`, and a healthcheck-driven respawn. The PWA is served from the same container, so the deploy is one image, one port, one volume.

If you don't have a strong preference, use Docker. The bare-metal path exists for hosts that can't run Docker or for operators who want full control over the Node runtime.

## Bare-metal path

### Build

From a fresh clone:

```bash
pnpm install
pnpm -C packages/engine build
```

`pnpm -C packages/engine build` compiles the engine to `packages/engine/dist`. Re-run it after pulling changes that touch `packages/engine` or `packages/shared`.

### Token

The supervisor reads `MINIONS_TOKEN` from the environment. Either export it from your shell profile:

```bash
export MINIONS_TOKEN='<a long random secret>'
```

…or put it in `.env.local` at the repo root. `scripts/supervise-engine.sh` sources `.env.local` before exec'ing the engine, so any variable set there is available to the child process.

### Run

```bash
bash scripts/supervise-engine.sh
```

The supervisor runs in the foreground. For unattended use, wrap it in `nohup` for a quick detach:

```bash
nohup bash scripts/supervise-engine.sh > /dev/null 2>&1 &
```

…or install the systemd unit below for a reboot-safe service.

### Logs and crash forensics

- Engine log: `~/.minions/logs/engine.log`. Rotated at 50 MB with 5 generations kept (`engine.log.1` … `engine.log.5`). Override the directory with `MINIONS_LOG_DIR`.
- Crash logs: `~/.minions/crashes/<iso>.log`, one file per crash, named with the ISO timestamp. Each file holds the last 200 lines of stdout/stderr captured before the engine exited non-zero. Override with `MINIONS_CRASH_LOG_DIR`.

### Backoff schedule

If the engine exits non-zero, the supervisor sleeps before respawning. The schedule is:

```
2s -> 5s -> 15s -> 30s -> 60s
```

After 5 crash-free minutes the counter resets to `2s`. Clean exits (signal-driven shutdown, `exit 0`) don't restart.

### Sample systemd unit

Drop this at `/etc/systemd/system/minions.service`:

```ini
[Unit]
Description=claude-minions engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minions
WorkingDirectory=/home/minions/claude-minions
EnvironmentFile=/home/minions/claude-minions/.env.local
ExecStart=/usr/bin/env bash scripts/supervise-engine.sh
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now minions
sudo systemctl status minions
```

`Restart=on-failure` covers the case where the supervisor itself dies; the supervisor's own backoff handles transient engine crashes inside that single process.

## Docker path

### Bring it up

```bash
docker compose up -d --build
```

`docker-compose.yml` already sets `restart: unless-stopped` and a healthcheck that hits `/api/health` every 30s. The combination handles respawn: if the container exits, Docker restarts it; if the healthcheck fails repeatedly, the container is marked unhealthy and you can wire `--exit-on-unhealthy` or external monitoring on top.

### Forensics

```bash
# Tail the last 200 lines of engine logs.
docker compose logs --tail=200 engine

# Inspect healthcheck state, including the last few probe results.
docker inspect minions --format='{{json .State.Health}}'
```

Combine the two when the container is restarting in a tight loop: `logs` shows what the engine emitted before exit, `inspect` shows whether the healthcheck or the process itself triggered the restart.

### `MINIONS_TOKEN` injection

Three options, ordered by what most operators should pick first:

- **`.env.deploy` env_file (recommended).** `docker-compose.yml` already references `env_file: [.env.deploy]`. Put `MINIONS_TOKEN=<secret>` in that file alongside the other deploy vars and keep it out of version control.
- **`docker run -e`.** For one-off runs without compose: `docker run -e MINIONS_TOKEN=<secret> minions/engine:local`. Tokens passed this way are visible in `docker inspect` and the host's process listing — fine for local testing, not for shared hosts.
- **Compose `secrets:` block.** When you want the token mounted as a file rather than an env var. Add a top-level `secrets:` declaration backed by a file outside the repo, mount it into the service, and point the engine at it. This is the hardened option for multi-tenant hosts; skip it for a personal mini PC.

## Mini-PC overnight checklist

Run through this once when you set up the box, then again any time you change the deploy path.

- **Disable suspend.** Most desktop distros suspend on idle. Mask the targets so they can't fire:

  ```bash
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```

- **Auto-start on boot (Docker).**

  ```bash
  sudo systemctl enable docker
  ```

  Compose's `restart: unless-stopped` handles the rest once Docker is up.

- **Auto-start on boot (bare-metal).**

  ```bash
  sudo systemctl enable minions
  ```

- **Verify `MINIONS_TOKEN`.** For the systemd path, confirm the unit's `EnvironmentFile` resolves and contains the token:

  ```bash
  sudo systemctl show minions -p EnvironmentFiles
  sudo -u minions env -i bash -c 'set -a; source /home/minions/claude-minions/.env.local; env | grep MINIONS_TOKEN'
  ```

- **Tail the first 10 minutes.** Watch the engine log and crash dir while you exercise the API:

  ```bash
  tail -F ~/.minions/logs/engine.log
  ls -lt ~/.minions/crashes/ | head
  ```

- **LAN reachability.** From a second host on the LAN:

  ```bash
  curl -i http://<mini-pc>:8787/api/health
  ```

  A `200 OK` confirms both the listener and the configured provider are reachable. A non-200 means the port is open but the engine isn't healthy — see troubleshooting.

- **Back up `engine.db`.** The sqlite database holds session state, transcripts, and the DAG. Schedule an `rsync` to a second disk on cron:

  ```cron
  0 * * * * rsync -a /home/minions/claude-minions/data/workspace/engine.db /mnt/backup/minions/engine.db
  ```

  Adjust the source path for the bare-metal layout (`~/.minions/...`) if you don't use the Docker `./data` mount.

- **Smoke test.** Create a session via the API, watch it land, then stop it:

  ```bash
  curl -X POST http://<mini-pc>:8787/api/sessions \
    -H "Authorization: Bearer $MINIONS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"repoId":"self","prompt":"echo hello","slug":"smoke"}'
  ```

  Confirm the session shows up in the PWA, completes, and that no crash log appears.

## Troubleshooting

- **Supervisor keeps respawning.** The engine is exiting non-zero in a loop. Tail the latest crash log:

  ```bash
  ls -t ~/.minions/crashes/ | head -1 | xargs -I{} tail -200 ~/.minions/crashes/{}
  ```

  The 200 lines captured before exit usually pinpoint the cause: missing env, port already bound, sqlite migration failure, or an unhandled rejection from a provider call.

- **Engine refuses to start.** The most common cause is `MINIONS_TOKEN` validation. The engine refuses to boot without a token, and the supervisor surfaces that as an immediate exit. For systemd installs, check the unit's resolved environment:

  ```bash
  sudo systemctl show minions -p Environment -p EnvironmentFiles
  sudo journalctl -u minions -n 100
  ```

  If the token is set but the engine still refuses, look for an env-parse error in the first few lines of `engine.log`.

- **Healthcheck fails but logs look fine.** `/api/health` returns `200` only when the configured provider is reachable. A failing healthcheck with a quiet log usually means the provider endpoint is unreachable from the host (DNS, outbound firewall, or a stale `ANTHROPIC_API_KEY`). Hit `/api/doctor` for the full snapshot:

  ```bash
  curl -s http://<mini-pc>:8787/api/doctor | jq
  ```

  The `provider` field in the response identifies which provider check is failing.
