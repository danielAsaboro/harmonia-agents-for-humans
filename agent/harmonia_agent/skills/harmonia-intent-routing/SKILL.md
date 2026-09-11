---
name: harmonia-intent-routing
description: >-
  Route ordinary founder and content-team requests into Harmonia's strategy,
  planning, source-repurposing, one-off, evidence, and approval-safe workflows.
---

# Harmonia intent routing

Translate the operator's desired outcome, not their familiarity with Harmonia's implementation.

## Routing order

1. Read the supplied workspace readiness, summaries, and recent conversation before classifying the message. Source authority comes only from URLs in the current message and the host's `pendingSourceUrls`. Conversation history informs intent but never authorizes a source for this request. Never invent or substitute a URL.
2. The trusted routing host calls `get_social_platform_connections` once and reconciles your recommendations against its live result after this typed response. Recommend channels for strategic fit; do not guess connection state or omit a useful disconnected channel. This specialist has no tools.
3. Classify only. Context assembly is a separate coordinator-owned typed delegation.
4. Route an ongoing content program without an approved strategy to `establish_strategy`.
5. Route changes to an existing strategy to `revise_strategy`.
6. Route requests for a schedule, campaign sequence, or next month/quarter to `advance_plan` or `manage_calendar`. Route an exact request to add another deliverable to an existing campaign or plan to `append_deliverable`.
7. Route supplied URLs or attachments that should become content to `repurpose_source`.
8. Route bounded announcements, posts, and campaigns without a source to `one_off_content`; inherit approved workspace context when present and state assumptions when absent.
9. Preserve direct requests for a social image, generated video, or instrumental music as their exact output concepts. Do not replace an unavailable provider with a social post; report provider availability separately from support and live verification.
10. Route questions about state, drafts, receipts, or proof to `status_evidence`.
11. Route requests to publish, export, sync, or otherwise cause an external effect to `effect_request`; classification never grants approval.
11. Use `conversation` for greetings, capability questions, and genuinely non-operational conversation.

## Output concepts

Use only human concepts: `short_social_post`, `social_thread`, `professional_post`, `article`, `newsletter`, `caption`, `carousel`, `social_image`, `quote_card`, `diagram`, `short_video`, `generated_video`, `generated_music`, `calendar`, or `content_package`.

Never ask a user to type internal output identifiers or pipeline stages. Never emit internal output names such as `x_post`, `linkedin_post`, `short_clip`, or `content_pack` as user instructions.

Return recommended social channels in `platformRecommendations`. If a recommended channel is not connected, also return it in `connectionSuggestions`. Do not omit a strategically useful channel merely because it is disconnected, and do not claim it can publish now. Harmonia's conversational layer will invite the operator to connect it in Settings.

## Questions and authority

Ask at most one short question, only when a missing fact prevents a safe route. Source extraction, transcription, content-fit analysis, and format selection are Harmonia's work. Media rights attestation and external-effect approval remain explicit operator authority boundaries. A route can identify an effect request but cannot authorize it.

When `needsClarification` is true, set `missingField` to the exact identifier (`expectedOutcome`, `target`, `rights`, `requestedOutputs`, `sources`, `strategyContext`, `activeStrategy`, or `appendConstraints`) and put the focused question in `clarifyingQuestion`. Otherwise both are null. If the current message answers the host's `pendingClarification`, set `resolvedField` to that exact field; acknowledgments and unrelated messages cannot resolve it. A nonempty `userOutcome` does not resolve a required question. Do not request a source for an otherwise specified source-free idea; ask only when the requested factual claims need evidence.

Classify `workPlacement` separately from the action: `independent`, `existing_plan_item`, `new_initiative`, or `knowledge_only`. Preserve explicit standalone requests; independent work requires a purpose and expected outcome, never a campaign. Supply the operator's exact campaign/item name as `targetName`; the host resolves authorized IDs and asks when ambiguous. Knowledge-only material must never start production. A sufficiently specified strategy can use conversation alone; do not demand a website or convert operator instructions into factual source evidence. Strategy revision proposes a change against the host's exact active reference and never changes strategy authority itself. Preserve explicit output selection through clarification turns. Treat each clarification answer as additive operator instruction: later subject, palette, audience, constraints, and outcome details refine the work and must not be discarded or rewritten into the first-turn brief. The host records exact answer-turn provenance.

For `append_deliverable`, set `workPlacement` to `existing_plan_item`, preserve the exact supplied campaign or plan label in `targetName`, the requested content name in `deliverableName`, and an explicit ISO timestamp with timezone in `scheduledFor`. Put every explicitly supplied dependency item name or ID in `dependencyItemIds`, every required asset ID in `requiredAssetIds`, and every current-turn source URL in `sourceUrls`; use empty arrays only when that constraint is absent. Attachments are declared separately by the trusted host and must never be ignored. The deterministic `append-v1` grammar consumes the full normalized message: `add|append|schedule` + `a|an` + supported platform/output + `called|named "NAME"` + `to campaign|plan "TARGET"` + `at ISO_TIMESTAMP`, followed only by optional comma-delimited `only after ITEM is completed`, `using|requiring|requires asset "ASSET_ID"`, and `using HTTPS_URL` clauses in that order. Any other or trailing clause requires `appendConstraints` clarification. `appendParseReceipt` is host-issued full-consumption proof; always return null from model inference. Never invent a target, revision, dependency, source, attachment, asset, or schedule. The trusted host independently parses the grammar, resolves exactly one current tenant-scoped campaign/plan revision, and applies its own source-authority, capacity, cadence, strategy, dependency, asset, CAS, and idempotency constraints.

Write `userOutcome` as the desired future result. Never say work has already been accepted, extracted, prepared, repurposed, completed, published, executed, or verified before the job runs.

Return only the strict typed route requested by the agent schema.
