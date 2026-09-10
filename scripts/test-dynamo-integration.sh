#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
JAVA_BIN="${JAVA_BIN:-/opt/homebrew/opt/openjdk@21/bin/java}"
if [[ ! -x "$JAVA_BIN" ]]; then JAVA_BIN="$(command -v java)"; fi
: "${MINIO_BINARY:?Set MINIO_BINARY to the official local MinIO executable for versioned S3 tests.}"
: "${DYNAMODB_LOCAL_JAR:?Set DYNAMODB_LOCAL_JAR to the official DynamoDB Local jar; no cloud resources are created.}"
[[ -f "$DYNAMODB_LOCAL_JAR" ]] || { echo 'DynamoDB Local jar missing' >&2; exit 2; }
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/harmonia-dynamo.XXXXXX")"
java_pid=''; s3_pid=''; minio_pid=''
cleanup(){ [[ -z "$minio_pid" ]] || kill "$minio_pid" 2>/dev/null || true; [[ -z "$s3_pid" ]] || kill "$s3_pid" 2>/dev/null || true; [[ -z "$java_pid" ]] || kill "$java_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
export AWS_LOCAL_ENDPOINT='http://127.0.0.1:18766'
export AWS_S3_LOCAL_ENDPOINT='http://127.0.0.1:18767'
export AWS_REGION='us-east-1' AWS_ACCESS_KEY_ID='S3RVER' AWS_SECRET_ACCESS_KEY='S3RVER'
export DYNAMODB_TABLE='harmonia-integration' S3_BUCKET='harmonia-integration-assets'
export HARMONIA_ALLOW_PAID_AWS=false HARMONIA_ENABLE_QUEUE_CONSUMERS=false
export LOCAL_S3_DIRECTORY="$run_dir/s3"
mkdir -p "$LOCAL_S3_DIRECTORY"
"$JAVA_BIN" -Djava.library.path="$(dirname "$DYNAMODB_LOCAL_JAR")/DynamoDBLocal_lib" -jar "$DYNAMODB_LOCAL_JAR" -inMemory -sharedDb -port 18766 >"$run_dir/dynamo.log" 2>&1 &
java_pid=$!
if [[ -n "${MINIO_BINARY:-}" ]]; then
 export AWS_ACCESS_KEY_ID='S3RVER' AWS_SECRET_ACCESS_KEY='S3RVERSECRET'
 export MINIO_ROOT_USER="$AWS_ACCESS_KEY_ID" MINIO_ROOT_PASSWORD="$AWS_SECRET_ACCESS_KEY"
 "$MINIO_BINARY" server "$LOCAL_S3_DIRECTORY" --address 127.0.0.1:18767 --console-address 127.0.0.1:18769 >"$run_dir/minio.log" 2>&1 &
 minio_pid=$!
 for ((i=0;i<60;i++)); do
   if curl -sf http://127.0.0.1:18767/minio/health/live >/dev/null; then break; fi
   sleep 0.5
 done
fi
node scripts/local-data-services.mjs >"$run_dir/s3.log" 2>&1 &
s3_pid=$!
ready=false
for ((i=0;i<90;i++)); do
 if rg -q LOCAL_DATA_SERVICES_READY "$run_dir/s3.log"; then ready=true; break; fi
 if ! kill -0 "$s3_pid" 2>/dev/null; then cat "$run_dir/s3.log"; exit 1; fi
 sleep 0.5
done
[[ "$ready" == true ]] || { cat "$run_dir/dynamo.log" "$run_dir/s3.log"; exit 1; }
./node_modules/.bin/vitest run tests/*Dynamo.integration.test.ts tests/durableRuntimeObservability.integration.test.ts
