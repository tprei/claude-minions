#!/usr/bin/env bash
# The supervisor is now embedded in the engine and starts automatically.
# This script starts the engine in production mode.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi
exec pnpm --filter @minions/engine run start
