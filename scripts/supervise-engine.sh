#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi
if [ -f packages/engine/dist/bin/supervise.js ]; then
  exec node packages/engine/dist/bin/supervise.js "$@"
else
  exec pnpm --filter @minions/engine exec tsx packages/engine/src/bin/supervise.ts "$@"
fi
