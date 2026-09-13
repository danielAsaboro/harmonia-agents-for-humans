#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
readonly release_sha="$(git rev-parse HEAD)"
readonly evidence_dir="${RELEASE_EVIDENCE_DIR:-.artifacts/release-${release_sha}}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Release verification requires a clean exact-SHA checkout." >&2
  exit 2
fi
if [[ -z "${DYNAMODB_LOCAL_JAR:-}" || -z "${MINIO_BINARY:-}" ]]; then
  echo "Set DYNAMODB_LOCAL_JAR and MINIO_BINARY to verified local emulator artifacts." >&2
  exit 2
fi
if [[ ! -x agent/.venv/bin/python ]]; then
  echo "Create agent/.venv with Python 3.12 and install agent/requirements.lock." >&2
  exit 2
fi
if ! agent/.venv/bin/python -c 'import pip_audit' >/dev/null 2>&1; then
  echo "Install pip-audit into the release verification environment." >&2
  exit 2
fi

mkdir -p "$evidence_dir"
git show --no-patch --format=fuller HEAD >"$evidence_dir/commit.txt"
git status --short --branch >"$evidence_dir/status-before.txt"

run_check() {
  local name="$1"
  shift
  "$@" 2>&1 | tee "$evidence_dir/${name}.log"
}

run_check diff-check git diff --check
run_check web-tests npm test
run_check integration npm run test:integration
run_check agent-tests npm run test:agent
run_check lint npm run lint
run_check typecheck npx tsc --noEmit
run_check build npm run build
run_check cdk-synth npm run infra:synth
run_check npm-audit npm audit --omit=dev --audit-level=high
run_check pip-audit agent/.venv/bin/python -m pip_audit -r agent/requirements.lock --cache-dir "${PIP_AUDIT_CACHE_DIR:-${TMPDIR:-/tmp}/harmonia-pip-audit-cache}"
run_check sbom npm run security:sbom -- "$evidence_dir/sbom"

git status --short --branch >"$evidence_dir/status-after.txt"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Verification changed the tracked checkout; exact-SHA evidence is invalid." >&2
  exit 1
fi
printf '{"commit":"%s","result":"passed","scope":"local exact-SHA verification; no AWS deployment or provider invocation"}\n' "$release_sha" >"$evidence_dir/result.json"
echo "Release verification passed for ${release_sha}; evidence: ${evidence_dir}"
