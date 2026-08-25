#!/usr/bin/env bash
# One-time Google Cloud project bootstrap for Harmonia.
# Idempotent: safe to re-run. Requires: gcloud authenticated, billing enabled.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"

echo "== Harmonia setup on project ${PROJECT_ID} (${REGION}) =="

gcloud config set project "${PROJECT_ID}"

echo "-- Enabling services"
for svc in run.googleapis.com firestore.googleapis.com pubsub.googleapis.com \
           cloudbuild.googleapis.com artifactregistry.googleapis.com \
           secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
           cloudresourcemanager.googleapis.com \
           aiplatform.googleapis.com cloudtrace.googleapis.com \
           telemetry.googleapis.com monitoring.googleapis.com logging.googleapis.com \
           storage.googleapis.com identitytoolkit.googleapis.com cloudscheduler.googleapis.com; do
  gcloud services enable "$svc" --project "${PROJECT_ID}"
done

echo "-- Agent Engine staging bucket"
STAGING_BUCKET="gs://${PROJECT_ID}-harmonia-agent-staging"
if ! gcloud storage buckets describe "${STAGING_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "${STAGING_BUCKET}" \
    --location="${REGION}" --uniform-bucket-level-access --project="${PROJECT_ID}"
fi
BUCKET_LOCATION="$(gcloud storage buckets describe "${STAGING_BUCKET}" \
  --project="${PROJECT_ID}" --format='value(location)' | tr '[:upper:]' '[:lower:]')"
if [[ "${BUCKET_LOCATION}" != "${REGION}" ]]; then
  echo "staging bucket is in ${BUCKET_LOCATION}; required residency region is ${REGION}" >&2
  exit 2
fi

echo "-- Durable media bucket"
ASSET_BUCKET="gs://${PROJECT_ID}-harmonia-assets"
if ! gcloud storage buckets describe "${ASSET_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "${ASSET_BUCKET}" \
    --location="${REGION}" --uniform-bucket-level-access --project="${PROJECT_ID}"
fi
ASSET_BUCKET_LOCATION="$(gcloud storage buckets describe "${ASSET_BUCKET}" \
  --project="${PROJECT_ID}" --format='value(location)' | tr '[:upper:]' '[:lower:]')"
if [[ "${ASSET_BUCKET_LOCATION}" != "${REGION}" ]]; then
  echo "asset bucket is in ${ASSET_BUCKET_LOCATION}; required residency region is ${REGION}" >&2
  exit 2
fi

echo "-- Firestore (native mode)"
if ! gcloud firestore databases describe --database='(default)' --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud firestore databases create --location="${REGION}" --type=firestore-native --project "${PROJECT_ID}"
fi
FIRESTORE_LOCATION="$(gcloud firestore databases describe --database='(default)' \
  --project "${PROJECT_ID}" --format='value(locationId)' | tr '[:upper:]' '[:lower:]')"
if [[ "${FIRESTORE_LOCATION}" != "${REGION}" ]]; then
  echo "Firestore is in ${FIRESTORE_LOCATION}; required residency region is ${REGION}" >&2
  exit 2
fi

echo "-- Pub/Sub topics"
gcloud pubsub topics create harmonia-stages --project "${PROJECT_ID}" 2>/dev/null || echo "topic exists"
gcloud pubsub topics create harmonia-stages-dlq --project "${PROJECT_ID}" 2>/dev/null || echo "dlq topic exists"
for topic in harmonia-stages harmonia-stages-dlq; do
  gcloud pubsub topics update "${topic}" --project "${PROJECT_ID}" \
    --message-storage-policy-allowed-regions="${REGION}" \
    --message-storage-policy-enforce-in-transit
done

echo "-- Service accounts"
for sa in harmonia-web harmonia-agent harmonia-pubsub-push harmonia-scheduler; do
  gcloud iam service-accounts create "$sa" --project "${PROJECT_ID}" \
    --display-name "Harmonia ${sa}" 2>/dev/null || echo "sa $sa exists"
done

# The web service exchanges verified Google/Firebase ID tokens for secure
# server-side session cookies. Keep this authority narrower than Firebase Admin.
FIREBASE_SESSION_ROLE="harmoniaFirebaseSessionIssuer"
FIREBASE_SESSION_PERMISSIONS="firebaseauth.users.createSession,firebaseauth.users.get,resourcemanager.projects.get"
if ! gcloud iam roles describe "${FIREBASE_SESSION_ROLE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam roles create "${FIREBASE_SESSION_ROLE}" --project "${PROJECT_ID}" \
    --title="Harmonia Firebase Session Issuer" \
    --description="Create and verify Harmonia Firebase server sessions" \
    --permissions="${FIREBASE_SESSION_PERMISSIONS}" --stage=GA
else
  gcloud iam roles update "${FIREBASE_SESSION_ROLE}" --project "${PROJECT_ID}" \
    --title="Harmonia Firebase Session Issuer" \
    --description="Create and verify Harmonia Firebase server sessions" \
    --permissions="${FIREBASE_SESSION_PERMISSIONS}" --stage=GA
fi
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role "projects/${PROJECT_ID}/roles/${FIREBASE_SESSION_ROLE}" >/dev/null

gcloud storage buckets add-iam-policy-binding "${ASSET_BUCKET}" \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/storage.objectAdmin --project "${PROJECT_ID}" >/dev/null

# Cloud Run metadata credentials sign short-lived upload/download URLs through
# IAM Credentials. Scope that authority to the web identity signing as itself.
gcloud iam service-accounts add-iam-policy-binding \
  "harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountTokenCreator --project "${PROJECT_ID}" >/dev/null

# Pub/Sub's service agent must mint the OIDC token used by the private worker's
# push subscription; it receives no general project-level token authority.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format 'value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding \
  "harmonia-pubsub-push@${PROJECT_ID}.iam.gserviceaccount.com" \
  --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role roles/iam.serviceAccountTokenCreator --project "${PROJECT_ID}" >/dev/null

for sa in harmonia-web harmonia-agent; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role roles/cloudtrace.agent >/dev/null
done

echo "-- IAM (least privilege)"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/datastore.user >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/pubsub.publisher >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:harmonia-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/datastore.user >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:harmonia-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/aiplatform.user >/dev/null
# Secret access is granted per named secret below. Cloud Run invocation is
# granted only on the private agent service after deployment.

echo "-- Secrets (skipped when value envs are unset)"
if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  printf '%s' "${GEMINI_API_KEY}" | gcloud secrets create gemini-api-key --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || printf '%s' "${GEMINI_API_KEY}" | gcloud secrets versions add gemini-api-key --data-file=- --project "${PROJECT_ID}"
else
  echo "  GEMINI_API_KEY not provided; create secret 'gemini-api-key' manually."
fi
if [[ -n "${YOUTUBE_API_KEY:-}" ]]; then
  printf '%s' "${YOUTUBE_API_KEY}" | gcloud secrets create youtube-api-key --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || printf '%s' "${YOUTUBE_API_KEY}" | gcloud secrets versions add youtube-api-key --data-file=- --project "${PROJECT_ID}"
else
  echo "  YOUTUBE_API_KEY not provided; ingest falls back to oEmbed."
fi
if [[ -n "${GOOGLE_CLIENT_ID:-}" || -n "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  : "${GOOGLE_CLIENT_ID:?set GOOGLE_CLIENT_ID together with GOOGLE_CLIENT_SECRET}"
  : "${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET together with GOOGLE_CLIENT_ID}"
  printf '%s' "${GOOGLE_CLIENT_ID}" | gcloud secrets create google-oauth-client-id --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || printf '%s' "${GOOGLE_CLIENT_ID}" | gcloud secrets versions add google-oauth-client-id --data-file=- --project "${PROJECT_ID}"
  printf '%s' "${GOOGLE_CLIENT_SECRET}" | gcloud secrets create google-oauth-client-secret --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || printf '%s' "${GOOGLE_CLIENT_SECRET}" | gcloud secrets versions add google-oauth-client-secret --data-file=- --project "${PROJECT_ID}"
else
  echo "  Google OAuth credentials not provided; Calendar and YouTube OAuth will remain unavailable."
fi
if [[ -n "${MALWARE_SCANNER_TOKEN:-}" ]]; then
  printf '%s' "${MALWARE_SCANNER_TOKEN}" | gcloud secrets create malware-scanner-token --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
    || printf '%s' "${MALWARE_SCANNER_TOKEN}" | gcloud secrets versions add malware-scanner-token --data-file=- --project "${PROJECT_ID}"
else
  echo "  MALWARE_SCANNER_TOKEN not provided; production deployment will refuse upload enablement."
fi
INTERNAL_TOKEN="$(openssl rand -hex 32)"
printf '%s' "${INTERNAL_TOKEN}" | gcloud secrets create internal-api-token --data-file=- --project "${PROJECT_ID}" 2>/dev/null \
  || echo "internal-api-token secret already exists (not rotated)"

echo "Granting secret access to both services"
for sa in harmonia-web harmonia-agent; do
  gcloud secrets add-iam-policy-binding internal-api-token \
    --member "serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null
  gcloud secrets add-iam-policy-binding gemini-api-key \
    --member "serviceAccount:${sa}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null 2>&1 || true
done
for secret in google-oauth-client-id google-oauth-client-secret; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null 2>&1 || true
done
gcloud secrets add-iam-policy-binding malware-scanner-token \
  --member "serviceAccount:harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null 2>&1 || true
gcloud secrets add-iam-policy-binding youtube-api-key \
  --member "serviceAccount:harmonia-agent@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor --project "${PROJECT_ID}" >/dev/null 2>&1 || true

cat <<DONE

Setup complete.
  Topic:        projects/${PROJECT_ID}/topics/harmonia-stages
  Firestore:    (default) @ ${REGION}
  Web SA:       harmonia-web@${PROJECT_ID}.iam.gserviceaccount.com
  Agent SA:     harmonia-agent@${PROJECT_ID}.iam.gserviceaccount.com
  Push SA:      harmonia-pubsub-push@${PROJECT_ID}.iam.gserviceaccount.com
  Scheduler SA: harmonia-scheduler@${PROJECT_ID}.iam.gserviceaccount.com
  Assets:       ${ASSET_BUCKET}

Next: ./infra/deploy.sh   (deploys both Cloud Run services and wires the push subscription)
DONE
