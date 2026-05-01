#!/usr/bin/env bash
# Pull origin/main, rebuild + restart the engine container if HEAD moved.
# Idempotent: a no-op when origin/main has not advanced.
# Defers the rebuild if any session is in `running` status, so a cron tick
# does not nuke a live claude-code provider mid-turn.
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="${LOG:-$HOME/.claude-minions-deploy.log}"
LOCK="/tmp/claude-minions-redeploy.lock"
ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:8787}"

ts() { date -Is; }

# Single-instance guard. flock -n exits non-zero if another run holds the lock.
exec 9>"$LOCK"
flock -n 9 || { echo "[$(ts)] another redeploy in progress; skip" >>"$LOG"; exit 0; }

cd "$REPO"

# Source MINIONS_TOKEN from .env.deploy if not already in env.
if [ -z "${MINIONS_TOKEN:-}" ] && [ -f "$REPO/.env.deploy" ]; then
  MINIONS_TOKEN="$(grep -E '^MINIONS_TOKEN=' "$REPO/.env.deploy" | head -1 | cut -d= -f2- || true)"
fi

git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

# Drain check: refuse to rebuild while any session is `running`. The next cron
# tick (5 min later) retries. Skipped silently if the engine is unreachable
# (first install, or already crashed) or if jq is missing — neither is a
# reason to block forever.
if [ -n "${MINIONS_TOKEN:-}" ] && command -v jq >/dev/null 2>&1; then
  RUNNING_COUNT=$(
    curl -fsS -m 5 -H "Authorization: Bearer $MINIONS_TOKEN" \
      "$ENGINE_URL/api/sessions" 2>/dev/null \
      | jq -r '(.items // .)[] | select(.status == "running") | .slug' 2>/dev/null \
      | wc -l \
      || echo 0
  )
  if [ "$RUNNING_COUNT" -gt 0 ]; then
    echo "[$(ts)] deferring redeploy: $RUNNING_COUNT session(s) running" >>"$LOG"
    exit 0
  fi
fi

echo "[$(ts)] new commits ${LOCAL:0:7} -> ${REMOTE:0:7}; redeploying" >>"$LOG"

# Defensive stash in case docker-compose.yml or other tracked files have
# uncommitted local edits.
STASH_BEFORE=$(git stash list | wc -l)
git stash push -u -m "redeploy-$(date +%s)" >/dev/null 2>&1 || true
STASH_AFTER=$(git stash list | wc -l)

if ! git pull --ff-only origin main >>"$LOG" 2>&1; then
  echo "[$(ts)] git pull failed (non-ff); manual intervention required" >>"$LOG"
  [ "$STASH_AFTER" -gt "$STASH_BEFORE" ] && git stash pop >/dev/null 2>&1 || true
  exit 1
fi

if [ "$STASH_AFTER" -gt "$STASH_BEFORE" ]; then
  if ! git stash pop >>"$LOG" 2>&1; then
    echo "[$(ts)] stash pop conflict; manual intervention required" >>"$LOG"
    exit 1
  fi
fi

docker compose --profile tunnel up -d --build >>"$LOG" 2>&1

# Wait for healthcheck to flip to healthy before declaring success.
for i in $(seq 1 30); do
  if [ "$(docker inspect minions --format "{{.State.Health.Status}}" 2>/dev/null)" = "healthy" ]; then
    echo "[$(ts)] redeploy complete: $(git rev-parse --short HEAD) (healthy)" >>"$LOG"
    exit 0
  fi
  sleep 2
done
echo "[$(ts)] redeploy: container did not reach healthy in 60s" >>"$LOG"
exit 1
