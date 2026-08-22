#!/usr/bin/env bash
# One-time Google Cloud project bootstrap for Closefold.
# Idempotent: safe to re-run. Requires: gcloud authenticated, billing enabled.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"

echo "== Closefold setup on project ${PROJECT_ID} (${REGION}) =="

gcloud config set project "${PROJECT_ID}"

echo "-- Enabling services"
for svc in run.googleapis.com firestore.googleapis.com pubsub.googleapis.com \
           cloudbuild.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
           aiplatform.googleapis.com; do
  gcloud services enable "$svc" --project "${PROJECT_ID}"
done

echo "-- Firestore (native mode)"
if ! gcloud firestore databases describe --database='(default)' --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud firestore databases create --location="${REGION}" --type=firestore-native --project "${PROJECT_ID}"
fi

echo "-- Pub/Sub topics"
gcloud pubsub topics create closefold-stages --project "${PROJECT_ID}" 2>/dev/null || echo "topic exists"
gcloud pubsub topics create closefold-stages-dlq --project "${PROJECT_ID}" 2>/dev/null || echo "dlq topic exists"

echo "-- Service accounts"
for sa in closefold-web closefold-agent; do
  gcloud iam service-accounts create "$sa" --project "${PROJECT_ID}" \
    --display-name "Closefold ${sa}" 2>/dev/null || echo "sa $sa exists"
done

echo "-- IAM (least privilege)"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:closefold-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/datastore.user >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:closefold-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/pubsub.publisher >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:closefold-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/datastore.user >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:closefold-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor >/dev/null
# Agent may invoke nothing else; web needs no invoker. Push subscription uses its own OIDC identity:
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:closefold-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/run.invoker >/dev/null

echo "-- Secrets (skipped when value envs are unset)"
if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  printf '%s' "${GEMINI_API_KEY}" | gcloud secrets create gemini-api-key --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || printf '%s' "${GEMINI_API_KEY}" | gcloud secrets versions add gemini-api-key --data-file=- --project "${PROJECT_ID}"
else
  echo "  GEMINI_API_KEY not provided; create secret 'gemini-api-key' manually."
fi
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  printf '%s' "${GITHUB_TOKEN}" | gcloud secrets create github-token --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || printf '%s' "${GITHUB_TOKEN}" | gcloud secrets versions add github-token --data-file=- --project "${PROJECT_ID}"
else
  echo "  GITHUB_TOKEN not provided; create secret 'github-token' manually."
fi

INTERNAL_TOKEN="$(openssl rand -hex 32)"
printf '%s' "${INTERNAL_TOKEN}" | gcloud secrets create internal-api-token --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
  || echo "internal-api-token secret already exists (not rotated)"

if [[ -n "${OPERATOR_TOKEN:-}" ]]; then
  printf '%s' "${OPERATOR_TOKEN}" | gcloud secrets create operator-token --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || echo "operator-token secret already exists (not rotated)"
else
  OPERATOR_TOKEN="$(openssl rand -hex 16)"
  printf '%s' "${OPERATOR_TOKEN}" | gcloud secrets create operator-token --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || echo "operator-token secret already exists"
fi

echo "Granting secret access to both services"
for sa in closefold-web closefold-agent; do
  gcloud secrets add-iam-policy-binding internal-api-token \
    --member "serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null
  gcloud secrets add-iam-policy-binding gemini-api-key \
    --member "serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null 2>&1 || true
  gcloud secrets add-iam-policy-binding github-token \
    --member "serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null 2>&1 || true
done

gcloud secrets add-iam-policy-binding operator-token \
  --member "serviceAccount:closefold-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null

echo
echo "Operator token (enter this in the dashboard 'Operator token' field):"
echo "  $(gcloud secrets versions access latest --secret=operator-token --project "${PROJECT_ID}")"

cat <<DONE

Setup complete.
  Topic:        projects/${PROJECT_ID}/topics/closefold-stages
  Firestore:    (default) @ ${REGION}
  Web SA:       closefold-web@${PROJECT_ID}.iam.gserviceaccount.com
  Agent SA:     closefold-agent@${PROJECT_ID}.iam.gserviceaccount.com

Next: ./infra/deploy.sh   (deploys both Cloud Run services and wires the push subscription)
DONE
