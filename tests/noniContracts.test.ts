import { describe, expect, it } from "vitest";
import {
  contentDraftSchema,
  copywriterInputSchema,
  editorialReviewSchema,
} from "@/lib/contracts";
import type { ContentDraft, CopywriterInput, EditorialReview } from "@/lib/types";

const brief = {
  id: "brief-1", title: "Operational proof", objective: "Show verified operating proof", audienceId: "founders", funnelStage: "consideration" as const,
  keyMessage: "Harmonia keeps content execution governed.", channelCandidates: ["x"], formatCandidates: ["text_post"],
  ctaIntent: "request a demo", intendedConversion: "qualified demo request", kpi: "qualified demos", priority: 1,
  dependencies: [], constraints: ["Use an evidence-led voice"], evidenceRefs: ["moment-1", "angle-1"],
};

const editorialItem = {
  id: "item-1", briefId: "brief-1", campaignTheme: "Evidence before execution", contentPillar: "operational proof",
  objective: "Show verified operating proof", audienceId: "founders", funnelStage: "consideration" as const, intendedConversion: "qualified demo request",
  ctaIntent: "request a demo", kpi: "qualified demos", channel: "x", format: "text_post", evidenceRefs: ["moment-1", "angle-1"],
  publicationWindowStartAt: "2026-09-01T16:00:00Z", publicationWindowEndAt: "2026-09-01T18:00:00Z", productionDeadlineAt: "2026-08-31T18:00:00Z",
  priority: 1, selectionScore: 0.9, dependencies: [], productionStatus: "planned" as const, constraints: ["Use an evidence-led voice"], requiredAssets: [],
  planningRationale: "The first proof post opens the campaign.", selectionRationale: "It is the selected item.", confidence: "high" as const,
};

const originalDraft: ContentDraft = {
  id: "draft-1", planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64), editorialItemId: "item-1", briefId: "brief-1",
  revision: 1, platform: "x", format: "text_post", text: "Evidence-led teams cut the gap between a content decision and its governed execution. Request a demo.",
  ctaTreatment: "Invite founders to request a demo.", intendedConversion: "qualified demo request", evidenceRefs: ["moment-1", "angle-1"],
  claims: [{ text: "The source describes reducing a nine-day delay to forty hours.", evidenceRefs: ["moment-1"] }],
  assumptions: ["A direct founder-focused hook suits the selected X item."], confidence: "high", appliedConstraints: ["Use an evidence-led voice"],
  priorDraftId: null, addressedIssueIds: [],
};

const reviseReview: EditorialReview = {
  id: "review-1", planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64), editorialItemId: "item-1", briefId: "brief-1",
  draftId: "draft-1", revision: 1, verdict: "revise", reviewedAt: "2026-08-27T10:00:00Z",
  issues: [{ id: "issue-1", category: "clarity", severity: "medium", fieldPath: "text", instruction: "Name the source qualification before the call to action.", evidenceRefs: ["moment-1"], constraintRefs: [] }],
};

const originalInput: CopywriterInput = {
  planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64), editorialItemId: "item-1", briefId: "brief-1",
  editorialItem, brief, referencedMoments: [{ id: "moment-1", title: "Activation lesson", startSec: 1, endSec: 8, hook: "Cut the delay", quote: "We cut nine days to forty hours." }],
  referencedAngles: [{ id: "angle-1", kind: "trend", title: "Evidence-led execution", rationale: "Founders need verifiable operating proof." }],
  brandContext: "Direct, evidence-led, and concise.", constraints: ["Use an evidence-led voice"], platform: "x", format: "text_post", passType: "original",
  priorDraft: null, priorReview: null,
};

describe("Noni and Dara contracts", () => {
  it("accepts one complete original and revision chain", () => {
    const revision: CopywriterInput = { ...originalInput, passType: "revision", priorDraft: originalDraft, priorReview: reviseReview };
    const revisionDraft: ContentDraft = { ...originalDraft, id: "draft-2", revision: 2, priorDraftId: "draft-1", addressedIssueIds: ["issue-1"] };

    expect(copywriterInputSchema.parse(originalInput).editorialItemId).toBe("item-1");
    expect(copywriterInputSchema.parse(revision).priorReview?.issues[0]?.id).toBe("issue-1");
    expect(contentDraftSchema.parse(revisionDraft).addressedIssueIds).toEqual(["issue-1"]);
    expect(editorialReviewSchema.parse(reviseReview).verdict).toBe("revise");
  });

  it.each([
    [copywriterInputSchema, { ...originalInput, unexpected: "no" }],
    [contentDraftSchema, { ...originalDraft, alternatives: ["second post"] }],
    [copywriterInputSchema, { ...originalInput, brief: { ...brief, id: "brief-other" } }],
    [copywriterInputSchema, { ...originalInput, passType: "original", priorDraft: originalDraft }],
    [copywriterInputSchema, { ...originalInput, passType: "revision", priorDraft: null, priorReview: reviseReview }],
    [copywriterInputSchema, { ...originalInput, platform: "linkedin" }],
    [contentDraftSchema, { ...originalDraft, confidence: "certain" }],
    [contentDraftSchema, { ...originalDraft, publishPayload: { type: "publish_x_post" } }],
    [editorialReviewSchema, { ...reviseReview, receipt: { id: "forbidden" } }],
    [contentDraftSchema, { ...originalDraft, text: "x".repeat(281) }],
  ])("rejects closed-world boundary violations", (schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it.each([
    [contentDraftSchema, { ...originalDraft, claims: Array.from({ length: 13 }, () => originalDraft.claims[0]) }],
    [contentDraftSchema, { ...originalDraft, evidenceRefs: [] }],
    [contentDraftSchema, { ...originalDraft, appliedConstraints: [""] }],
    [editorialReviewSchema, { ...reviseReview, reviewedAt: "2026-08-27T11:00:00+01:00" }],
    [editorialReviewSchema, { ...reviseReview, issues: [] }],
  ])("enforces blank/list limits and strict UTC fields", (schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it.each([
    [contentDraftSchema, originalDraft, "claims"],
    [contentDraftSchema, originalDraft, "assumptions"],
    [contentDraftSchema, originalDraft, "priorDraftId"],
    [contentDraftSchema, originalDraft, "addressedIssueIds"],
    [copywriterInputSchema, originalInput, "referencedMoments"],
    [copywriterInputSchema, originalInput, "referencedAngles"],
    [copywriterInputSchema, originalInput, "constraints"],
    [copywriterInputSchema, originalInput, "priorDraft"],
    [copywriterInputSchema, originalInput, "priorReview"],
    [editorialReviewSchema, reviseReview, "issues"],
    [editorialReviewSchema, reviseReview, "issues.0.evidenceRefs"],
    [editorialReviewSchema, reviseReview, "issues.0.constraintRefs"],
  ])("requires every nullable and list boundary field", (schema, fixture, field) => {
    const payload = structuredClone(fixture) as unknown as Record<string, unknown>;
    if (field.startsWith("issues.0.")) {
      delete (payload.issues as Array<Record<string, unknown>>)[0][field.split(".").at(-1)!];
    } else {
      delete payload[field];
    }
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it.each([
    [contentDraftSchema, { ...originalDraft, revision: "1" }],
    [contentDraftSchema, { ...originalDraft, claims: [{ ...originalDraft.claims[0], text: 1 }] }],
    [contentDraftSchema, { ...originalDraft, assumptions: [1] }],
    [copywriterInputSchema, { ...originalInput, planId: 1 }],
    [copywriterInputSchema, { ...originalInput, constraints: [1] }],
    [editorialReviewSchema, { ...reviseReview, revision: "1" }],
    [editorialReviewSchema, { ...reviseReview, reviewedAt: 1 }],
    [editorialReviewSchema, { ...reviseReview, issues: [{ ...reviseReview.issues[0], instruction: 1 }] }],
    [editorialReviewSchema, { ...reviseReview, issues: [{ ...reviseReview.issues[0], evidenceRefs: [1] }] }],
    [editorialReviewSchema, { ...reviseReview, issues: [{ ...reviseReview.issues[0], constraintRefs: [1] }] }],
  ])("does not coerce new boundary scalars", (schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it.each([
    [contentDraftSchema, { ...originalDraft, id: "draft-1", revision: 2, priorDraftId: "draft-1", addressedIssueIds: ["issue-1"] }],
    [contentDraftSchema, { ...originalDraft, id: "draft-2", revision: 2, priorDraftId: "draft-2", addressedIssueIds: ["issue-1"] }],
    [copywriterInputSchema, {
      ...originalInput,
      passType: "revision",
      priorDraft: { ...originalDraft, id: "draft-2", revision: 2, priorDraftId: "draft-1", addressedIssueIds: ["issue-1"] },
      priorReview: { ...reviseReview, draftId: "draft-2", revision: 2 },
    }],
  ])("rejects reused draft ids and third-pass revision targets", (schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });
});
