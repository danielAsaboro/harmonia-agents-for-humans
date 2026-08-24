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
PRESENTER_MODEL_ID="${PRESENTER_MODEL_ID:-gemini-3.5-flash}"
GEMMA_VERTEX_ENDPOINT="${GEMMA_VERTEX_ENDPOINT:?set GEMMA_VERTEX_ENDPOINT to the deployed Gemma endpoint resource}"
GEMMA_MAX_COST_USD="${GEMMA_MAX_COST_USD:-0.100000}"
MODEL_PRICING_VERSION="${MODEL_PRICING_VERSION:-2026-08-23}"
DEFAULT_JOB_BUDGET_USD="${DEFAULT_JOB_BUDGET_USD:-5.00}"
DEFAULT_JOB_APPROVAL_THRESHOLD_USD="${DEFAULT_JOB_APPROVAL_THRESHOLD_USD:-0.25}"
IMAGE_MAX_COST_USD="${IMAGE_MAX_COST_USD:-0.500000}"
DEFAULT_WORKSPACE_BUDGET_USD="${DEFAULT_WORKSPACE_BUDGET_USD:-100.00}"
AGENT_ENGINE_RESOURCE="${AGENT_ENGINE_RESOURCE:?set AGENT_ENGINE_RESOURCE to the deployed reasoning engine resource}"
MEMORY_BANK_ENABLED="true"
MEMORY_BANK_RESOURCE="${MEMORY_BANK_RESOURCE:-${AGENT_ENGINE_RESOURCE}}"
GENERATIVE_MEDIA_ENABLED="${GENERATIVE_MEDIA_ENABLED:-false}"
ALLOW_GLOBAL_LYRIA="${ALLOW_GLOBAL_LYRIA:-false}"
VERTEX_MEDIA_LOCATION="${VERTEX_MEDIA_LOCATION:-${REGION}}"
FIREBASE_API_KEY="${FIREBASE_API_KEY:?set FIREBASE_API_KEY for Identity Platform web sign-in}"
FIREBASE_AUTH_DOMAIN="${FIREBASE_AUTH_DOMAIN:-${PROJECT_ID}.firebaseapp.com}"
FIREBASE_APP_ID="${FIREBASE_APP_ID:?set FIREBASE_APP_ID for the registered web application}"
GCS_BUCKET="${GCS_BUCKET:-${PROJECT_ID}-harmonia-assets}"

resource_location() {
  local resource="$1"
  if [[ "${resource}" =~ /locations/([^/]+)/ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  echo "resource has no /locations/<region>/ segment: ${resource}" >&2
  exit 2
}

require_region() {
  local label="$1"
  local resource="$2"
  local actual
  actual="$(resource_location "${resource}")"
  if [[ "${actual}" != "${REGION}" ]]; then
    echo "${label} is in ${actual}; required residency region is ${REGION}" >&2
    exit 2
  fi
}

require_region "Agent Engine" "${AGENT_ENGINE_RESOURCE}"
require_region "Gemma endpoint" "${GEMMA_VERTEX_ENDPOINT}"
require_region "Memory Bank" "${MEMORY_BANK_RESOURCE}"
if [[ "${VERTEX_MEDIA_LOCATION}" != "${REGION}" ]]; then
  echo "Vertex media is in ${VERTEX_MEDIA_LOCATION}; required residency region is ${REGION}" >&2
  exit 2
fi
if [[ "${GENERATIVE_MEDIA_ENABLED}" == "true" && "${ALLOW_GLOBAL_LYRIA}" != "true" ]]; then
  echo "generative media includes global Lyria; set ALLOW_GLOBAL_LYRIA=true only after an approved residency-policy exception" >&2
  exit 2
fi

if [[ -z "${MEMORY_BANK_RESOURCE}" ]]; then
  echo "MEMORY_BANK_RESOURCE is required when MEMORY_BANK_ENABLED=true" >&2
  exit 2
fi

gcloud config set project "${PROJECT_ID}"

# Only mount secrets that exist so optional integrations never block deploys.
secret_exists() {
  gcloud secrets describe "$1" --project "${PROJECT_ID}" >/dev/null 2>&1
}

WEB_SECRETS="INTERNAL_API_TOKEN=internal-api-token:latest"
if secret_exists gemini-api-key; then
  WEB_SECRETS="${WEB_SECRETS},GEMINI_API_KEY=gemini-api-key:latest"
fi
for pair in GOOGLE_CLIENT_ID:google-oauth-client-id GOOGLE_CLIENT_SECRET:google-oauth-client-secret; do
  env_name="${pair%%:*}"; secret_name="${pair##*:}"
  if ! secret_exists "${secret_name}"; then
    echo "required Google OAuth secret '${secret_name}' not found; run infra/setup.sh with GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" >&2
    exit 2
  fi
  WEB_SECRETS="${WEB_SECRETS},${env_name}=${secret_name}:latest"
done

echo "== Deploying harmonia-web (Next.js) =="
gcloud run deploy harmonia-web \
  --source . \
  --region "${REGION}" \
  --service-account "harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --set-build-env-vars "NEXT_PUBLIC_FIREBASE_API_KEY=${FIREBASE_API_KEY},NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN},NEXT_PUBLIC_FIREBASE_PROJECT_ID=${PROJECT_ID},NEXT_PUBLIC_FIREBASE_APP_ID=${FIREBASE_APP_ID}" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},GCS_BUCKET=${GCS_BUCKET},MODEL_ID=${MODEL_ID},MODEL_PRICING_VERSION=${MODEL_PRICING_VERSION},DEFAULT_JOB_BUDGET_USD=${DEFAULT_JOB_BUDGET_USD},DEFAULT_JOB_APPROVAL_THRESHOLD_USD=${DEFAULT_JOB_APPROVAL_THRESHOLD_USD},DEFAULT_WORKSPACE_BUDGET_USD=${DEFAULT_WORKSPACE_BUDGET_USD},HARMONIA_TELEMETRY_ENABLED=1,HARMONIA_TELEMETRY_SAMPLE_RATE=1.0,OTEL_SERVICE_NAME=harmonia-web,OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT,ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false" \
  --set-secrets "${WEB_SECRETS}" \
  --project "${PROJECT_ID}"

WEB_URL="$(gcloud run services describe harmonia-web --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')"
echo "web: ${WEB_URL}"

CORS_FILE="$(mktemp)"
trap 'rm -f "${CORS_FILE}"' EXIT
printf '[{"origin":["%s"],"method":["GET","HEAD","PUT"],"responseHeader":["Content-Type","Range","x-goog-resumable"],"maxAgeSeconds":3600}]' \
  "${WEB_URL}" > "${CORS_FILE}"
gcloud storage buckets update "gs://${GCS_BUCKET}" \
  --cors-file="${CORS_FILE}" --project "${PROJECT_ID}"

AGENT_SECRETS="INTERNAL_API_TOKEN=internal-api-token:latest"
for pair in GEMINI_API_KEY:gemini-api-key YOUTUBE_API_KEY:youtube-api-key; do
  env_name="${pair%%:*}"; secret_name="${pair##*:}"
  if secret_exists "${secret_name}"; then
    AGENT_SECRETS="${AGENT_SECRETS},${env_name}=${secret_name}:latest"
  else
    echo "  secret '${secret_name}' not found; ${env_name} left unset"
  fi
done
AGENT_ENV="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},WEB_INTERNAL_URL=${WEB_URL},PUBSUB_STAGE_TOPIC=harmonia-stages,MODEL_ID=${MODEL_ID},COORDINATOR_MODEL_ID=${COORDINATOR_MODEL_ID},STRATEGIST_MODEL_ID=${STRATEGIST_MODEL_ID},ANALYST_MODEL_ID=${ANALYST_MODEL_ID},COPYWRITER_MODEL_ID=${COPYWRITER_MODEL_ID},EDITOR_MODEL_ID=${EDITOR_MODEL_ID},PLANNER_MODEL_ID=${PLANNER_MODEL_ID},PRESENTER_MODEL_ID=${PRESENTER_MODEL_ID},GEMMA_VERTEX_ENDPOINT=${GEMMA_VERTEX_ENDPOINT},GEMMA_MAX_COST_USD=${GEMMA_MAX_COST_USD},MODEL_PRICING_VERSION=${MODEL_PRICING_VERSION},DEFAULT_JOB_BUDGET_USD=${DEFAULT_JOB_BUDGET_USD},DEFAULT_JOB_APPROVAL_THRESHOLD_USD=${DEFAULT_JOB_APPROVAL_THRESHOLD_USD},IMAGE_MAX_COST_USD=${IMAGE_MAX_COST_USD},AGENT_ENGINE_RESOURCE=${AGENT_ENGINE_RESOURCE},MEMORY_BANK_ENABLED=${MEMORY_BANK_ENABLED},MEMORY_BANK_RESOURCE=${MEMORY_BANK_RESOURCE},GENERATIVE_MEDIA_ENABLED=${GENERATIVE_MEDIA_ENABLED},ALLOW_GLOBAL_LYRIA=${ALLOW_GLOBAL_LYRIA},VERTEX_MEDIA_LOCATION=${VERTEX_MEDIA_LOCATION},HARMONIA_TELEMETRY_ENABLED=1,HARMONIA_TELEMETRY_SAMPLE_RATE=1.0,OTEL_SERVICE_NAME=harmonia-agent,OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT,ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false"

echo "== Deploying harmonia-agent (Python ADK worker) =="
pushd agent >/dev/null
gcloud run deploy harmonia-agent \
  --source . \
  --region "${REGION}" \
  --service-account "harmonia-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --min-instances 1 --max-instances 1 --no-cpu-throttling \
  --timeout 300 \
  --set-env-vars "${AGENT_ENV}" \
  --set-secrets "${AGENT_SECRETS}" \
  --project "${PROJECT_ID}"
popd >/dev/null

AGENT_URL="$(gcloud run services describe harmonia-agent --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')"
echo "agent: ${AGENT_URL}"

gcloud run services add-iam-policy-binding harmonia-agent \
  --region "${REGION}" --project "${PROJECT_ID}" \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/run.invoker >/dev/null

gcloud run services update harmonia-web \
  --region "${REGION}" --project "${PROJECT_ID}" \
  --update-env-vars "AGENT_SERVICE_URL=${AGENT_URL}" >/dev/null

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
