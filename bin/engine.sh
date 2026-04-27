#!/usr/bin/env bash
# Source .env.local if present, then run the engine.
# Use this in dev so secrets stay out of your shell rc.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi
exec pnpm --filter @minions/engine run dev
