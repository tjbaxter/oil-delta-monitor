#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.local"
  set +a
fi

PYTHON_BIN="python3"
if [[ -x ".venv/bin/python" ]]; then
  PYTHON_BIN=".venv/bin/python"
fi

exec "${PYTHON_BIN}" "services/live_ingestor/main.py"
