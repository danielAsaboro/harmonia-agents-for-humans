#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "${HARMONIA_ALLOW_PAID_DEPLOYMENT:-false}" != true ]]; then
  echo "Secret rotation disabled: authorize AWS operations first." >&2
  exit 2
fi
if [[ "${HARMONIA_APPROVE_SECRET_ROTATION:-}" != "rotate-internal-service-tokens" ]]; then
  echo "Secret rotation disabled: set HARMONIA_APPROVE_SECRET_ROTATION=rotate-internal-service-tokens for this maintenance window." >&2
  exit 2
fi

: "${AWS_REGION:=us-east-1}"
: "${HARMONIA_STAGE:=staging}"
case "$HARMONIA_STAGE" in
  staging) default_stack_name="HarmoniaStrandsStaging" ;;
  production) default_stack_name="HarmoniaStrandsProduction" ;;
  *) echo "HARMONIA_STAGE must be staging or production." >&2; exit 2 ;;
esac
: "${HARMONIA_STACK_NAME:=$default_stack_name}"
export AWS_REGION
[[ "$AWS_REGION" == us-east-1 ]] || { echo "This edition is pinned to us-east-1." >&2; exit 2; }
command -v aws >/dev/null
command -v jq >/dev/null
command -v openssl >/dev/null

output_value() {
  aws cloudformation describe-stacks --stack-name "$HARMONIA_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

readonly cluster_name="$(output_value ClusterName)"
readonly web_service="$(output_value WebServiceName)"
readonly worker_service="$(output_value WorkerServiceName)"
readonly scanner_service="$(output_value ScannerServiceName)"
readonly token_secret="$(output_value InternalTokenSecretArn)"
readonly scanner_secret="$(output_value ScannerTokenSecretArn)"
readonly runtime_id="$(output_value RuntimeId)"
for value in "$cluster_name" "$web_service" "$worker_service" "$scanner_service" "$token_secret" "$scanner_secret" "$runtime_id"; do
  [[ -n "$value" && "$value" != None ]] || { echo "Required stack output is missing; rotation aborted before mutation." >&2; exit 1; }
done

runtime_state="$(mktemp "${TMPDIR:-/tmp}/harmonia-runtime-before-rotation.XXXXXX.json")"
runtime_update="$(mktemp "${TMPDIR:-/tmp}/harmonia-runtime-update.XXXXXX.json")"
cleanup() { rm -f "$runtime_state" "$runtime_update"; }
trap cleanup EXIT INT TERM
chmod 600 "$runtime_state" "$runtime_update"
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$runtime_id" --output json >"$runtime_state"
jq --arg clientToken "$(openssl rand -hex 32)" '
  {
    agentRuntimeId,
    agentRuntimeArtifact,
    roleArn,
    networkConfiguration,
    protocolConfiguration,
    description,
    authorizerConfiguration,
    requestHeaderConfiguration,
    lifecycleConfiguration,
    metadataConfiguration,
    filesystemConfigurations,
    environmentVariables,
    clientToken: $clientToken
  }
  | with_entries(select(.value != null))
  | select(.agentRuntimeId != null and .agentRuntimeArtifact != null and .roleArn != null and .networkConfiguration != null)
' "$runtime_state" >"$runtime_update"
jq -e '.agentRuntimeId and .agentRuntimeArtifact and .roleArn and .networkConfiguration' "$runtime_update" >/dev/null

rotate_secret() {
  local secret_arn="$1"
  local token
  token="$(aws secretsmanager get-random-password --password-length 48 --exclude-punctuation --query RandomPassword --output text)"
  [[ ${#token} -eq 48 ]] || { echo "Secrets Manager returned an invalid token; rotation aborted." >&2; exit 1; }
  aws secretsmanager put-secret-value --secret-id "$secret_arn" --secret-string "$token" --output json >/dev/null
  unset token
}

rotate_secret "$token_secret"
rotate_secret "$scanner_secret"
readonly runtime_version="$(aws bedrock-agentcore-control update-agent-runtime --cli-input-json "file://${runtime_update}" --query agentRuntimeVersion --output text)"
[[ -n "$runtime_version" && "$runtime_version" != None ]] || { echo "AgentCore runtime did not return a replacement version." >&2; exit 1; }
for service in "$worker_service" "$scanner_service" "$web_service"; do
  aws ecs update-service --cluster "$cluster_name" --service "$service" --force-new-deployment --output json >/dev/null
done
aws ecs wait services-stable --cluster "$cluster_name" --services "$worker_service" "$scanner_service" "$web_service"

runtime_status=""
for _ in {1..60}; do
  runtime_status="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$runtime_id" --agent-runtime-version "$runtime_version" --query status --output text)"
  [[ "$runtime_status" != FAILED ]] || { echo "AgentCore runtime replacement failed; use AWSPREVIOUS recovery from the runbook." >&2; exit 1; }
  [[ "$runtime_status" == READY ]] && break
  sleep 10
done
[[ "$runtime_status" == READY ]] || { echo "AgentCore runtime replacement did not become ready before the deadline." >&2; exit 1; }

echo "Internal service tokens rotated; ECS and AgentCore runtime replacements are ready. Verify health before ending the maintenance window."
