#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${HARMONIA_ALLOW_PAID_DEPLOYMENT:-false}" != true ]]; then
  echo "AWS bootstrap disabled until an operator authorizes deployment spend." >&2
  exit 2
fi
: "${AWS_REGION:=us-east-1}"
account_id=$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)
exec ./node_modules/.bin/cdk bootstrap "aws://${account_id}/${AWS_REGION}"
