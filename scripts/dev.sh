#!/usr/bin/env bash
# Local development loop using the real Firestore and Pub/Sub emulators.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-harmonia-local}"
export GOOGLE_CLOUD_PROJECT="$PROJECT_ID"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
export PUBSUB_EMULATOR_HOST="127.0.0.1:8082"

if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
fi

echo "== Starting emulators =="
gcloud beta emulators firestore start --host-port "$FIRESTORE_EMULATOR_HOST" --project "$PROJECT_ID" >/dev/null 2>&1 &
gcloud beta emulators pubsub start --host-port "$PUBSUB_EMULATOR_HOST" --project "$PROJECT_ID" >/dev/null 2>&1 &
sleep 4

cleanup() {
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "== Next.js dev server (:3000) =="
./node_modules/.bin/next dev &
WEB_PID=$!

echo "== ADK worker (pull loop against emulator) =="
pushd agent >/dev/null
if [[ ! -d .venv ]]; then python3 -m venv .venv && ./.venv/bin/pip install -q -r requirements.txt; fi
export WEB_INTERNAL_URL="http://localhost:3000"
export INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-local-dev-token}"
export PUBSUB_STAGE_TOPIC="harmonia-stages"
./.venv/bin/uvicorn harmonia_agent.main:app --port 8080 &
popd >/dev/null

wait $WEB_PID
