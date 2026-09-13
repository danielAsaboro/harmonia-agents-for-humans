#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "${HARMONIA_ALLOW_PAID_DEPLOYMENT:-false}" != true ]]; then
  echo "Restore drill disabled: authorize cloud spend first." >&2
  exit 2
fi
if [[ "${HARMONIA_APPROVE_RESTORE_DRILL:-}" != "restore-to-isolated-target" ]]; then
  echo "Restore drill disabled: set HARMONIA_APPROVE_RESTORE_DRILL=restore-to-isolated-target for this run." >&2
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
: "${RESTORE_ROLE_ARN:?Set the dedicated restore role ARN}"
export AWS_REGION
[[ "$AWS_REGION" == us-east-1 ]] || { echo "This edition is pinned to us-east-1." >&2; exit 2; }
command -v aws >/dev/null
command -v jq >/dev/null

output_value() {
  aws cloudformation describe-stacks --stack-name "$HARMONIA_STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

readonly table_arn="$(output_value StateTableArn)"
readonly vault_name="$(output_value BackupVaultName)"
for required_output in "$table_arn" "$vault_name"; do
  [[ -n "$required_output" && "$required_output" != None ]] || { echo "Required stack output is missing; restore aborted before mutation." >&2; exit 1; }
done
readonly target_table="${RESTORE_TARGET_TABLE:-harmonia-restore-drill-$(date -u +%Y%m%d%H%M%S)}"
[[ "$target_table" =~ ^[A-Za-z0-9_.-]{3,255}$ ]] || { echo "Invalid isolated restore table name." >&2; exit 2; }

readonly recovery_point="$(aws backup list-recovery-points-by-resource --resource-arn "$table_arn" \
  --query 'sort_by(RecoveryPoints[?Status==`COMPLETED`], &CreationDate)[-1].RecoveryPointArn' --output text)"
[[ -n "$recovery_point" && "$recovery_point" != None ]] || { echo "No completed DynamoDB recovery point exists." >&2; exit 1; }

metadata_file="$(mktemp "${TMPDIR:-/tmp}/harmonia-restore-metadata.XXXXXX.json")"
cleanup() { rm -f "$metadata_file"; }
trap cleanup EXIT INT TERM
chmod 600 "$metadata_file"
aws backup get-recovery-point-restore-metadata --backup-vault-name "$vault_name" --recovery-point-arn "$recovery_point" \
  --query RestoreMetadata --output json | jq --arg table "$target_table" '.targetTableName = $table' >"$metadata_file"
jq -e --arg table "$target_table" '.targetTableName == $table' "$metadata_file" >/dev/null

readonly restore_job="$(aws backup start-restore-job --recovery-point-arn "$recovery_point" \
  --iam-role-arn "$RESTORE_ROLE_ARN" --metadata "file://${metadata_file}" --query RestoreJobId --output text)"
restore_status=""
for _ in {1..90}; do
  restore_status="$(aws backup describe-restore-job --restore-job-id "$restore_job" --query Status --output text)"
  [[ "$restore_status" != FAILED && "$restore_status" != ABORTED ]] || { echo "Restore drill failed with status ${restore_status}." >&2; exit 1; }
  [[ "$restore_status" == COMPLETED ]] && break
  sleep 10
done
[[ "$restore_status" == COMPLETED ]] || { echo "Restore drill did not complete before the deadline." >&2; exit 1; }
aws dynamodb describe-table --table-name "$target_table" --query 'Table.{TableName:TableName,TableStatus:TableStatus,ItemCount:ItemCount,TableArn:TableArn}' --output json
echo "Restore drill passed. The isolated table remains for inspection; deletion requires a separate explicit cleanup approval."
