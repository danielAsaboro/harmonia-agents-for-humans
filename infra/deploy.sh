#!/usr/bin/env bash
# Deploys the Closefold web + ADK agent services to Cloud Run and wires the
# Pub/Sub push subscription. Idempotent; re-runs create new revisions.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
MODEL_ID="${MODEL_ID:-gemini-3.5-flash}"

gcloud config set project "${PROJECT_ID}"

echo "== Deploying closefold-web (Next.js) =="
gcloud run deploy closefold-web \
  --source . \
  --region "${REGION}" \
  --service-account "closefold-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},MODEL_ID=${MODEL_ID}" \
  --set-secrets "INTERNAL_API_TOKEN=internal-api-token:latest,OPERATOR_TOKEN=operator-token:latest" \
  --project "${PROJECT_ID}"

WEB_URL="$(gcloud run services describe closefold-web --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')"
echo "web: ${WEB_URL}"

echo "== Deploying closefold-agent (Python ADK worker) =="
pushd agent >/dev/null
gcloud run deploy closefold-agent \
  --source . \
  --region "${REGION}" \
  --service-account "closefold-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --min-instances 0 --max-instances 3 \
  --timeout 300 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},WEB_INTERNAL_URL=${WEB_URL},PUBSUB_STAGE_TOPIC=closefold-stages,MODEL_ID=${MODEL_ID}" \
  --set-secrets "INTERNAL_API_TOKEN=internal-api-token:latest,GEMINI_API_KEY=gemini-api-key:latest,GITHUB_TOKEN=github-token:latest" \
  --project "${PROJECT_ID}"
popd >/dev/null

AGENT_URL="$(gcloud run services describe closefold-agent --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')"
echo "agent: ${AGENT_URL}"

echo "== Wiring Pub/Sub push subscription =="
gcloud pubsub subscriptions create closefold-stages-agent-push \
  --topic closefold-stages \
  --push-endpoint "${AGENT_URL}/pubsub/push" \
  --oidc-service-account-email "closefold-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --oidc-token-audience "${AGENT_URL}/pubsub/push" \
  --ack-deadline 300 \
  --dead-letter-topic projects/${PROJECT_ID}/topics/closefold-stages-dlq \
  --max-delivery-attempts 5 \
  --project "${PROJECT_ID}" 2>/dev/null || echo "subscription exists"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format 'value(projectNumber)')"
gcloud pubsub topics add-iam-policy-binding closefold-stages-dlq \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role roles/pubsub.publisher --project "${PROJECT_ID}" >/dev/null 2>&1 || true

gcloud pubsub subscriptions add-iam-policy-binding closefold-stages-agent-push \
  --member "serviceAccount:closefold-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/pubsub.subscriber --project "${PROJECT_ID}" >/dev/null

echo
echo "Deployed. Dashboard: ${WEB_URL}"
echo "Smoke test:"
echo "  curl -s ${WEB_URL}/healthz || true"
