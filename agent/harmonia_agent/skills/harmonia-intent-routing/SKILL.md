---
name: harmonia-intent-routing
description: >-
  Route ordinary founder and content-team requests into Harmonia's strategy,
  planning, source-repurposing, one-off, evidence, and approval-safe workflows.
---

# Harmonia intent routing

Translate the operator's desired outcome, not their familiarity with Harmonia's implementation.

## Routing order

1. Read the supplied workspace readiness, summaries, and recent conversation before classifying the message. Carry forward facts the operator already supplied.
2. Call `get_social_platform_connections` once before recommending distribution channels. Treat only `connected: true` as connected.
3. Route an ongoing content program without an approved strategy to `establish_strategy`.
4. Route changes to an existing strategy to `revise_strategy`.
5. Route requests for a schedule, campaign sequence, or next month/quarter to `advance_plan` or `manage_calendar`.
6. Route supplied URLs or attachments that should become content to `repurpose_source`.
7. Route bounded announcements, posts, and campaigns without a source to `one_off_content`; inherit approved workspace context when present and state assumptions when absent.
8. Route questions about state, drafts, receipts, or proof to `status_evidence`.
9. Route requests to publish, export, sync, or otherwise cause an external effect to `effect_request`; classification never grants approval.
10. Use `conversation` for greetings, capability questions, and genuinely non-operational conversation.

## Output concepts

Use only human concepts: `short_social_post`, `social_thread`, `professional_post`, `article`, `newsletter`, `caption`, `carousel`, `social_image`, `quote_card`, `diagram`, `short_video`, `calendar`, or `content_package`.

Never ask a user to type internal output identifiers or pipeline stages. Never emit internal output names such as `x_post`, `linkedin_post`, `short_clip`, or `content_pack` as user instructions.

Return recommended social channels in `platformRecommendations`. If a recommended channel is not connected, also return it in `connectionSuggestions`. Do not omit a strategically useful channel merely because it is disconnected, and do not claim it can publish now. Harmonia's conversational layer will invite the operator to connect it in Settings.

## Questions and authority

Ask at most one short question, only when a missing fact prevents a safe route. Source extraction, transcription, content-fit analysis, and format selection are Harmonia's work. Media rights attestation and external-effect approval remain explicit operator authority boundaries. A route can identify an effect request but cannot authorize it.

Return only the strict typed route requested by the agent schema.
