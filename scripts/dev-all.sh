#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  if [[ -n "${LIVE_PID:-}" ]]; then
    kill "${LIVE_PID}" 2>/dev/null || true
    wait "${LIVE_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

bash scripts/dev-live.sh &
LIVE_PID=$!

npm run dev:web
