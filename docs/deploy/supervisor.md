# Supervisor runbook for unattended runs

This runbook covers running the engine unattended — overnight, on a mini PC, or
on any host where you want crashes to recover without a human in the loop. Two
deployment paths are supported: a bare-metal Node process under a shell
supervisor, and the Docker Compose stack with `restart: unless-stopped`.

## Overview

Pick the path that matches how the host is already managed:

- **Bare-metal** when Node is already installed, you want direct access to the
  worktree on disk, or you are iterating on engine code. The shell supervisor
  handles respawn and crash logs; pair it with `nohup` or a systemd unit for
  unattended use.
- **Docker** when you prefer an isolated runtime, want Docker's own restart
  policy and healthcheck to drive recovery, or are deploying to a host that
  already runs other containers.

Both paths land at the same place: a single engine process listening on
`MINIONS_PORT`, restarted on crash, with logs you can tail after the fact.

## Bare-metal path

### Build

From the repo root:

```bash
pnpm install
pnpm -C packages/engine build
```

### Token

Export `MINIONS_TOKEN` in the shell that launches the supervisor, or set it in
`.env.local` at the repo root. The supervisor refuses to start without it.

### Run

```bash
bash scripts/supervise-engine.sh
```

The supervisor runs in the foreground. For unattended use, wrap it with
`nohup`, run it under `tmux`, or install the systemd unit below.

### Logs and crashes

- Engine log: `~/.minions/logs/engine.log`, rotated at 50 MB with 5 generations
  kept.
- Crash logs: `~/.minions/crashes/<iso>.log`, one per crash, capturing the last
  ring-buffer window of stderr.

Override the locations with `MINIONS_LOG_DIR` and `MINIONS_CRASH_LOG_DIR` if
you want them on a different volume.

### Backoff schedule

After a crash, the supervisor sleeps before respawning: 2s, 5s, 15s, 30s, 60s.
The schedule resets to 2s after 5 crash-free minutes, so a healthy engine never
inherits a long backoff from an earlier bad day.

### Sample systemd unit

Drop this at `/etc/systemd/system/minions.service`, then `sudo systemctl
daemon-reload && sudo systemctl enable --now minions`:

```
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

`Restart=on-failure` covers the case where the supervisor itself dies; the
internal backoff handles engine-only crashes.

## Docker path

### Run

```bash
docker compose up -d --build
```

The compose service uses `restart: unless-stopped` plus a healthcheck against
`/api/health`. Docker respawns the container on crash; the healthcheck flips
the container to `unhealthy` if the engine hangs without exiting.

### Forensics

```bash
docker compose logs --tail=200 engine
docker inspect minions --format='{{json .State.Health}}'
```

The `State.Health` block carries the last few healthcheck probes with exit
codes and stderr, which is usually enough to tell a stuck process from a
crashed one.

### Token injection

Three options, in order of preference:

- **`env_file` in compose** — point the service at `.env.deploy` and put
  `MINIONS_TOKEN=...` there. This is the recommended default; it keeps the
  token out of the compose file and out of process listings.
- **`docker run -e MINIONS_TOKEN=...`** — fine for one-off runs, but the token
  ends up in shell history and `ps` output.
- **Compose `secrets:` block** — hardened option for hosts where other users
  can read environment files. The secret is mounted as a file at
  `/run/secrets/minions_token`; read it from an entrypoint shim that exports
  the value before exec'ing the engine.

## Mini-PC overnight checklist

Before walking away from the machine:

- Disable suspend, hibernate, and lid-close sleep:

  ```bash
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```

- Auto-start on boot:
  - Docker path: `sudo systemctl enable docker`.
  - Bare-metal path: `sudo systemctl enable minions`.
- Verify `MINIONS_TOKEN` is set in the unit's `EnvironmentFile` (or in
  `.env.deploy` for the Docker path). A missing token is the most common cause
  of a unit that "starts" but never serves traffic.
- Tail `~/.minions/logs/engine.log` and watch `~/.minions/crashes/` for the
  first 10 minutes. A clean window here is the strongest signal that the unit
  is healthy.
- From a second host on the LAN, confirm reachability:

  ```bash
  curl http://<mini-pc>:8787/api/health
  ```

  A 200 means the engine is up and the configured provider is reachable from
  inside the host.
- Back up `engine.db` to a second disk on cron. `rsync` from
  `./data/workspace/engine.db` (Docker) or `~/.minions/engine.db` (bare-metal)
  is enough; the file is sqlite and safe to copy while the engine runs.
- Run a smoke test: create a session via the API, watch it land in the PWA,
  then stop it. This exercises the spawn path, the worktree creation, and the
  shutdown signal in one pass.

## Troubleshooting

- **Supervisor keeps respawning.** Tail the most recent crash log:

  ```bash
  tail -n 200 ~/.minions/crashes/$(ls -t ~/.minions/crashes/ | head -1)
  ```

  The ring buffer captures stderr from the last window before the crash,
  which usually points at the failing call directly.
- **Engine refuses to start.** The most common cause is `MINIONS_TOKEN`
  validation. Check the unit's environment with `systemctl show minions
  --property=Environment` (bare-metal) or `docker compose config` (Docker) to
  confirm the variable is actually being passed in.
- **Healthcheck fails but logs look fine.** `/api/health` returns 200 only
  when the configured provider is reachable. A green engine talking to a
  provider that has gone away will still flip the container to `unhealthy`.
  Check provider connectivity from inside the host before assuming the engine
  is at fault.
