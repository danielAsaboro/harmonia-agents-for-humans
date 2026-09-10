#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env.local ]]; then set -a; source .env.local; set +a; fi
: "${INTERNAL_API_TOKEN:?configure INTERNAL_API_TOKEN in .env.local}"
export HARMONIA_ALLOW_PAID_AWS="${HARMONIA_ALLOW_PAID_AWS:-false}"
export HARMONIA_ENABLE_QUEUE_CONSUMERS="${HARMONIA_ENABLE_QUEUE_CONSUMERS:-false}"
export WEB_INTERNAL_URL="${WEB_INTERNAL_URL:-http://localhost:3000}"
export AGENT_SERVICE_URL="${AGENT_SERVICE_URL:-http://localhost:8080}"
: "${COGNITO_USER_POOL_ID:?configure a real Cognito pool; there is no development identity bypass}"
: "${COGNITO_CLIENT_ID:?configure Cognito client}"
if [[ ! -x agent/.venv/bin/python ]]; then
  python3 -m venv agent/.venv
  agent/.venv/bin/pip install -r agent/requirements.lock
fi
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
(cd agent && .venv/bin/uvicorn harmonia_agent.main:app --port 8080) &
pids+=("$!")
./node_modules/.bin/next dev &
pids+=("$!")
wait
