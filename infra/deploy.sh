#!/usr/bin/env bash
# Deploys the Harmonia web + ADK agent services to Cloud Run and wires the
# Pub/Sub push subscription. Idempotent; re-runs create new revisions.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
MODEL_ID="${MODEL_ID:-gemini-3.5-flash}"
COORDINATOR_MODEL_ID="${COORDINATOR_MODEL_ID:-gemini-3.5-flash-lite}"
STRATEGIST_MODEL_ID="${STRATEGIST_MODEL_ID:-gemini-3.5-flash}"
ANALYST_MODEL_ID="${ANALYST_MODEL_ID:-gemini-3.5-flash}"
COPYWRITER_MODEL_ID="${COPYWRITER_MODEL_ID:-gemma-3-12b-it}"
EDITOR_MODEL_ID="${EDITOR_MODEL_ID:-gemini-3.5-flash}"
PLANNER_MODEL_ID="${PLANNER_MODEL_ID:-gemini-3.5-flash-lite}"
GEMMA_VERTEX_ENDPOINT="${GEMMA_VERTEX_ENDPOINT:?set GEMMA_VERTEX_ENDPOINT to the deployed Gemma endpoint resource}"
GEMMA_MAX_COST_USD="${GEMMA_MAX_COST_USD:-0.100000}"
TELEGRAM_ALLOWED_CHAT_ID="${TELEGRAM_ALLOWED_CHAT_ID:-}"
MODEL_PRICING_VERSION="${MODEL_PRICING_VERSION:-2026-08-23}"
DEFAULT_JOB_BUDGET_USD="${DEFAULT_JOB_BUDGET_USD:-5.00}"
DEFAULT_JOB_APPROVAL_THRESHOLD_USD="${DEFAULT_JOB_APPROVAL_THRESHOLD_USD:-0.25}"
IMAGE_MAX_COST_USD="${IMAGE_MAX_COST_USD:-0.500000}"

gcloud config set project "${PROJECT_ID}"

# Only mount secrets that exist so optional integrations never block deploys.
secret_exists() {
  gcloud secrets describe "$1" --project "${PROJECT_ID}" >/dev/null 2>&1
}

WEB_SECRETS="INTERNAL_API_TOKEN=internal-api-token:latest,OPERATOR_TOKEN=operator-token:latest"
if secret_exists gemini-api-key; then
  WEB_SECRETS="${WEB_SECRETS},GEMINI_API_KEY=gemini-api-key:latest"
fi

echo "== Deploying harmonia-web (Next.js) =="
gcloud run deploy harmonia-web \
  --source . \
  --region "${REGION}" \
  --service-account "harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},MODEL_ID=${MODEL_ID},MODEL_PRICING_VERSION=${MODEL_PRICING_VERSION},DEFAULT_JOB_BUDGET_USD=${DEFAULT_JOB_BUDGET_USD},DEFAULT_JOB_APPROVAL_THRESHOLD_USD=${DEFAULT_JOB_APPROVAL_THRESHOLD_USD},HARMONIA_TELEMETRY_ENABLED=1,HARMONIA_TELEMETRY_SAMPLE_RATE=1.0,OTEL_SERVICE_NAME=harmonia-web,OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT,ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false" \
  --set-secrets "${WEB_SECRETS}" \
  --project "${PROJECT_ID}"

WEB_URL="$(gcloud run services describe harmonia-web --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')"
echo "web: ${WEB_URL}"

AGENT_SECRETS="INTERNAL_API_TOKEN=internal-api-token:latest,OPERATOR_TOKEN=operator-token:latest"
for pair in GEMINI_API_KEY:gemini-api-key X_BEARER_TOKEN:x-bearer-token YOUTUBE_API_KEY:youtube-api-key TELEGRAM_BOT_TOKEN:telegram-bot-token; do
  env_name="${pair%%:*}"; secret_name="${pair##*:}"
  if secret_exists "${secret_name}"; then
    AGENT_SECRETS="${AGENT_SECRETS},${env_name}=${secret_name}:latest"
  else
    echo "  secret '${secret_name}' not found; ${env_name} left unset"
  fi
done
AGENT_ENV="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},WEB_INTERNAL_URL=${WEB_URL},PUBSUB_STAGE_TOPIC=harmonia-stages,MODEL_ID=${MODEL_ID},COORDINATOR_MODEL_ID=${COORDINATOR_MODEL_ID},STRATEGIST_MODEL_ID=${STRATEGIST_MODEL_ID},ANALYST_MODEL_ID=${ANALYST_MODEL_ID},COPYWRITER_MODEL_ID=${COPYWRITER_MODEL_ID},EDITOR_MODEL_ID=${EDITOR_MODEL_ID},PLANNER_MODEL_ID=${PLANNER_MODEL_ID},GEMMA_VERTEX_ENDPOINT=${GEMMA_VERTEX_ENDPOINT},GEMMA_MAX_COST_USD=${GEMMA_MAX_COST_USD},MODEL_PRICING_VERSION=${MODEL_PRICING_VERSION},DEFAULT_JOB_BUDGET_USD=${DEFAULT_JOB_BUDGET_USD},DEFAULT_JOB_APPROVAL_THRESHOLD_USD=${DEFAULT_JOB_APPROVAL_THRESHOLD_USD},IMAGE_MAX_COST_USD=${IMAGE_MAX_COST_USD},HARMONIA_TELEMETRY_ENABLED=1,HARMONIA_TELEMETRY_SAMPLE_RATE=1.0,OTEL_SERVICE_NAME=harmonia-agent,OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT,ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false"
if [[ -n "${TELEGRAM_ALLOWED_CHAT_ID}" ]]; then
  AGENT_ENV="${AGENT_ENV},TELEGRAM_ALLOWED_CHAT_ID=${TELEGRAM_ALLOWED_CHAT_ID}"
fi

echo "== Deploying harmonia-agent (Python ADK worker) =="
pushd agent >/dev/null
gcloud run deploy harmonia-agent \
  --source . \
  --region "${REGION}" \
  --service-account "harmonia-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --min-instances 0 --max-instances 3 \
  --timeout 300 \
  --set-env-vars "${AGENT_ENV}" \
  --set-secrets "${AGENT_SECRETS}" \
  --project "${PROJECT_ID}"
popd >/dev/null

AGENT_URL="$(gcloud run services describe harmonia-agent --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')"
echo "agent: ${AGENT_URL}"

echo "== Wiring Pub/Sub push subscription =="
gcloud pubsub subscriptions create harmonia-stages-agent-push \
  --topic harmonia-stages \
  --push-endpoint "${AGENT_URL}/pubsub/push" \
  --oidc-service-account-email "harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --oidc-token-audience "${AGENT_URL}/pubsub/push" \
  --ack-deadline 300 \
  --dead-letter-topic projects/${PROJECT_ID}/topics/harmonia-stages-dlq \
  --max-delivery-attempts 5 \
  --project "${PROJECT_ID}" 2>/dev/null || echo "subscription exists"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format 'value(projectNumber)')"
gcloud pubsub topics add-iam-policy-binding harmonia-stages-dlq \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role roles/pubsub.publisher --project "${PROJECT_ID}" >/dev/null 2>&1 || true

gcloud pubsub subscriptions add-iam-policy-binding harmonia-stages-agent-push \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/pubsub.subscriber --project "${PROJECT_ID}" >/dev/null

echo
echo "Deployed. Dashboard: ${WEB_URL}"
echo "Smoke test:"
echo "  curl -s ${WEB_URL}/healthz || true"
