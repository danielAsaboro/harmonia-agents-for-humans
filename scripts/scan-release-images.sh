#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
readonly release_sha="$(git rev-parse HEAD)"
readonly output_dir="${IMAGE_SCAN_OUTPUT_DIR:-.artifacts/image-scan-${release_sha}}"

[[ -z "$(git status --porcelain)" ]] || { echo "Image scanning requires a clean exact-SHA checkout." >&2; exit 2; }
docker info >/dev/null
docker scout version >/dev/null
mkdir -p "$output_dir"

declare -a names=(web worker cognition scanner)
declare -a contexts=(. agent agent infra/malware-scanner)
declare -a files=(Dockerfile agent/Dockerfile agent/Dockerfile.agentcore infra/malware-scanner/Dockerfile)
scan_failed=false

for index in "${!names[@]}"; do
  name="${names[$index]}"
  image="harmonia-${name}:${release_sha}"
  docker build --load --label "org.opencontainers.image.revision=${release_sha}" --file "${files[$index]}" --tag "$image" "${contexts[$index]}"
  docker image inspect --format='{{json .Id}}' "$image" >"$output_dir/${name}-image-digest.json"
  if ! docker scout cves --exit-code --only-severity critical,high --format sarif --output "$output_dir/${name}-cves.sarif.json" "local://${image}"; then
    scan_failed=true
  fi
  docker scout sbom --format cyclonedx --output "$output_dir/${name}-sbom.cdx.json" "local://${image}"
done

if [[ "$scan_failed" == true ]]; then
  printf '{"commit":"%s","images":["%s"],"result":"failed","scope":"locally built images; nothing pushed"}\n' \
    "$release_sha" "$(IFS='","'; echo "${names[*]}")" >"$output_dir/result.json"
  echo "At least one local image has a high or critical finding; evidence: ${output_dir}" >&2
  exit 1
fi

printf '{"commit":"%s","images":["%s"],"result":"passed","scope":"locally built images; nothing pushed"}\n' \
  "$release_sha" "$(IFS='","'; echo "${names[*]}")" >"$output_dir/result.json"
echo "Local image scans passed for ${release_sha}; evidence: ${output_dir}"
