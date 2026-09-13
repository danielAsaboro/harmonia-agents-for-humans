#!/usr/bin/env bash
# This intentionally cannot provision billable resources without explicit opt-in.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${HARMONIA_ALLOW_PAID_DEPLOYMENT:-false}" != true ]]; then
  echo "Deployment disabled: operator must authorize a budget and set HARMONIA_ALLOW_PAID_DEPLOYMENT=true." >&2
  exit 2
fi
: "${AWS_REGION:=us-east-1}"
export AWS_REGION
[[ "$AWS_REGION" == us-east-1 ]] || { echo 'This edition is pinned to us-east-1.' >&2; exit 2; }
: "${AGENTCORE_IMAGE_URI:?Set the authorized ARM64 ECR image URI pinned by sha256}"
: "${PUBLIC_BASE_URL:?Set the reviewed HTTPS staging or production origin}"
: "${CERTIFICATE_ARN:?Set the ACM certificate ARN for that origin}"
: "${GOOGLE_CLIENT_ID:?Set the Google OAuth client ID}"
: "${GOOGLE_CLIENT_SECRET:?Set the Google OAuth client secret}"
: "${ALERT_EMAIL:?Set the confirmed operations mailbox}"
account_id="$(aws sts get-caller-identity --query Account --output text)"
image_prefix="$account_id.dkr.ecr.$AWS_REGION.amazonaws.com/"
[[ "$AGENTCORE_IMAGE_URI" == "$image_prefix"* ]] || { echo 'Cognition image must use the deployment account and region.' >&2; exit 2; }
[[ "$AGENTCORE_IMAGE_URI" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Cognition image must be digest-pinned.' >&2; exit 2; }
aws sts get-caller-identity --query Arn --output text >/dev/null
./node_modules/.bin/cdk synth --no-lookups "$@"
exec ./node_modules/.bin/cdk deploy --require-approval broadening "$@" \
  --parameters "AgentCoreImageUri=$AGENTCORE_IMAGE_URI" \
  --parameters "PublicBaseUrl=$PUBLIC_BASE_URL" \
  --parameters "CertificateArn=$CERTIFICATE_ARN" \
  --parameters "GoogleClientId=$GOOGLE_CLIENT_ID" \
  --parameters "GoogleClientSecret=$GOOGLE_CLIENT_SECRET" \
  --parameters "AlertEmail=$ALERT_EMAIL"
