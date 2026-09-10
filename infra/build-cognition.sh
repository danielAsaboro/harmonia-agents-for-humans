#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${HARMONIA_ALLOW_PAID_DEPLOYMENT:-false}" != true ]]; then
 echo 'ECR publication disabled: authorize a spending budget first.' >&2
 exit 2
fi
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit the reviewed source before building a release image.' >&2; exit 2; }
export AWS_REGION=us-east-1
account_id="$(aws sts get-caller-identity --query Account --output text)"
registry="$account_id.dkr.ecr.$AWS_REGION.amazonaws.com"
repository='harmonia-strands-cognition'
release="$(git rev-parse HEAD)"
if ! aws ecr describe-repositories --repository-names "$repository" >/dev/null 2>&1; then
 aws ecr create-repository --repository-name "$repository" --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true >/dev/null
fi
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
docker buildx build --platform linux/arm64 --file agent/Dockerfile.agentcore --tag "$registry/$repository:$release" --push agent
digest="$(aws ecr describe-images --repository-name "$repository" --image-ids "imageTag=$release" --query 'imageDetails[0].imageDigest' --output text)"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'ECR image digest unavailable.' >&2; exit 1; }
printf 'AGENTCORE_IMAGE_URI=%s/%s@%s\n' "$registry" "$repository" "$digest"
