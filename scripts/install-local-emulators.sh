#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
readonly tool_dir="${LOCAL_EMULATOR_DIR:-.artifacts/local-emulators}"
readonly dynamo_archive="$tool_dir/dynamodb_local_latest.tar.gz"
readonly dynamo_checksum="$tool_dir/dynamodb_local_latest.tar.gz.sha256"
readonly dynamo_expected="f80bcec477f85f57e2c77f8d54aa6b672a8403fceff0c450560aee1cf6c21163"
readonly minio_release="RELEASE.2025-09-07T16-13-09Z"
mkdir -p "$tool_dir/dynamodb"

curl -fsSL --retry 3 -o "$dynamo_archive" https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz
curl -fsSL --retry 3 -o "$dynamo_checksum" https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz.sha256
readonly published_dynamo_checksum="$(awk '{print $1}' "$dynamo_checksum")"
[[ "$published_dynamo_checksum" == "$dynamo_expected" ]] || {
  echo "DynamoDB Local release changed; inspect and deliberately update the pinned checksum." >&2
  exit 1
}
printf '%s *%s\n' "$dynamo_expected" "$dynamo_archive" | shasum -a 256 -c -
tar -xzf "$dynamo_archive" -C "$tool_dir/dynamodb"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    minio_asset="minio.linux-amd64.${minio_release}"
    minio_expected="7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f"
    ;;
  Darwin-arm64)
    minio_asset="minio.darwin-arm64.${minio_release}"
    minio_expected="7c3b3039b76e55a1b80935848ed83998d5e8d317374f87851f46a019ff5c0aa4"
    ;;
  *)
    echo "Unsupported emulator platform: $(uname -s)-$(uname -m)" >&2
    exit 2
    ;;
esac
readonly minio_binary="$tool_dir/minio"
curl -fsSL --retry 3 -o "$minio_binary" "https://github.com/minio/minio/releases/download/${minio_release}/${minio_asset}"
printf '%s *%s\n' "$minio_expected" "$minio_binary" | shasum -a 256 -c -
chmod 700 "$minio_binary"

readonly dynamo_jar="$(pwd)/$tool_dir/dynamodb/DynamoDBLocal.jar"
readonly minio_path="$(pwd)/$minio_binary"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'DYNAMODB_LOCAL_JAR=%s\nMINIO_BINARY=%s\n' "$dynamo_jar" "$minio_path" >>"$GITHUB_ENV"
else
  printf 'export DYNAMODB_LOCAL_JAR=%q\nexport MINIO_BINARY=%q\n' "$dynamo_jar" "$minio_path"
fi
