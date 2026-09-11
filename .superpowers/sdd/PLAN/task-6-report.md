# Task 6 report — persistent operating-loop presentation

## Delivered

- Added the read-only `/dashboard/operation` workspace and a no-store operator route. It projects only current durable strategy, proposals, campaigns, plans, planned work, approvals, jobs, and measured observations. It states empty, unavailable, blocked, and unresolved states directly.
- The operation projection binds each planned item to its pinned plan, strategy digest, metric definitions, evidence mode, current execution approval state, and dependency reason. A null campaign reference stays `Independent work`; no campaign link is invented.
- The calendar now uses the same durable projection to show why work exists, its pinned strategy and metrics, evidence mode, dependencies, unresolved reason, and independent-work state.
- The workspace page refreshes persisted state every 15 seconds only while visible. It aborts superseded requests and applies a response only when its local revision is still current, preventing older cards from overwriting a newer view.
- Maya's cross-runtime UI context now receives a host-provided `approvalState` summary. Its existing validators still bind components to exact records and forbid lifecycle authority or mutation.
- Nova's authorized workspace feed includes `freshness.readAt` and a `current` state. Nova validation rejects a workspace-feed answer without explicit freshness, and its instruction requires `stale`/`unavailable` to remain unresolved. The internal feed carries the same current-record projection.

## TDD and verification

- RED/GREEN: `tests/workspaceContentContext.test.ts` first failed without the operation projection, then passed. It covers active strategy, campaigns, independent work, operator-context evidence, exact metric, pending approval, blocked dependency, and unavailable results.
- RED/GREEN: `tests/calendarPresentation.test.ts` first failed without the planned-item presentation helper, then passed. It covers null campaign membership, pinned strategy/metric, evidence, dependency, and unresolved-state rendering.
- RED/GREEN: `agent/tests/test_nova_contracts.py` first failed because a workspace read without freshness was accepted, then passed after the validator change.
- A local DynamoDB/MinIO integration run initially caught the strict Python `IntentRoutingInput` rejecting the new TypeScript operation field. The Python bounded read-only contract was added; the rerun passed.
- `npm test`: 265 files passed, 978 tests passed; 30 local-integration files / 158 tests skipped outside the harness.
- `npm run test:agent`: 1060 passed, with one existing AnyIO deprecation warning.
- Loopback-only DynamoDB Local + MinIO: 30 files / 158 tests passed.
- Focused Telegram/chat/surface tests: 5 files / 19 tests passed.
- `npm run lint`, `npx tsc --noEmit --pretty false`, `npm run build`, `npm run infra:synth`, and `git diff --check` passed. CDK synth used `--no-lookups`.

## Limits

No paid model/provider invocation, external social effect, Telegram API call, deployment, push, merge, publication, or submission occurred. The browser refresh and Telegram behavior are covered by local component, routing, webhook, and durable cross-surface tests; no authenticated live UI or Bot API proof is claimed.
