#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm test -- \
  tests/authority.test.ts \
  tests/tenancy.test.ts \
  tests/attachmentOriginPolicy.test.ts \
  tests/artifactRoutes.test.ts \
  tests/malwareScan.test.ts \
  tests/sourceManifestRoute.test.ts \
  tests/telegramWebhook.test.ts \
  tests/telegramWebhookRoute.test.ts \
  tests/awsProductionReadiness.test.ts \
  tests/localLoadHarness.test.ts

# Native DynamoDB Local and MinIO exercise crash recovery, cross-tenant HTTP
# isolation (tests/tenantHttpIsolationDynamo.integration.test.ts), unknown-effect
# reconciliation, deletion, and idempotent replay.
npm run test:integration
