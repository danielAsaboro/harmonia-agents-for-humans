import { describe, expect, it } from "vitest";
import {
  analysisSubmissionSchema,
  budgetReservationSchema,
  budgetReservationResolutionSchema,
  draftsSubmissionSchema,
  failureSubmissionSchema,
  ingestSubmissionSchema,
  receiptSubmissionSchema,
  stageExecutionClaimSchema,
  stageExecutionFinalizeSchema,
  usageRecordSchema,
  verificationSubmissionSchema,
} from "@/lib/contracts";

const productionTrace = (() => {
  const draft = {
    id: "d1", planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64),
    editorialItemId: "item-1", briefId: "brief-1", revision: 1 as const,
    platform: "x" as const, format: "text_post" as const, audienceId: "founders",
    objective: "Show proof", funnelStage: "consideration" as const, ctaIntent: "request a demo",
    text: "hello world", ctaTreatment: "request a demo", intendedConversion: "qualified demo request",
    evidenceRefs: ["m1"], claims: [{ text: "hello world", evidenceRefs: ["m1"] }],
    assumptions: [], confidence: "high" as const, appliedConstraints: ["Use evidence"],
    priorDraftId: null, addressedIssueIds: [],
  };
  const review = {
    id: "r1", planId: draft.planId, planDigest: draft.planDigest, strategyDigest: draft.strategyDigest,
    editorialItemId: draft.editorialItemId, briefId: draft.briefId, draftId: draft.id,
    revision: 1 as const, verdict: "accepted" as const, reviewedAt: "2026-08-27T10:00:00Z",
    checks: ["grounding", "brief_alignment", "brand_voice", "platform_constraints", "cta", "safety", "clarity"].map((dimension) => ({ dimension, status: "pass", rationale: `Checked ${dimension}.`, evidenceRefs: [], constraintRefs: [] })),
    issues: [], resolvedIssueIds: [],
  };
  return { originalDraft: draft, reviews: [review], revisionDraft: null, acceptedDraft: draft };
})();

describe("internal contracts", () => {
  it("accepts a valid ingest submission", () => {
    const parsed = ingestSubmissionSchema.safeParse({
      jobId: "j1", stage: "ingest", videoId: "dQw4w9WgXcQ", title: "t",
      channel: "c", durationSec: 90, mediaBytes: 1024, mediaDigest: "a".repeat(32),
    });
    expect(parsed.success).toBe(true);
  });

  it("validates drafts with proposed publish actions", () => {
    const parsed = draftsSubmissionSchema.safeParse({
      jobId: "j1", stage: "draft",
      operation: "complete",
      editorialPlanId: "plan-1", editorialItemId: "item-1", briefId: "brief-1",
      editorialPlanDigest: "a".repeat(64),
      productionTrace,
      proposedActions: [
        { id: "a1", type: "publish_x_post", title: "post", description: "d",
          payload: { type: "publish_x_post", text: "hello world" } },
        { id: "a2", type: "export_content_pack", title: "pack", description: "d",
          payload: { type: "export_content_pack" } },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(draftsSubmissionSchema.safeParse({
      jobId: "j1", stage: "draft", operation: "claim",
      editorialPlanId: "plan-1", editorialPlanDigest: "a".repeat(64),
      editorialItemId: "item-1", briefId: "brief-1",
    }).success).toBe(true);
    expect(draftsSubmissionSchema.safeParse({
      jobId: "j1", stage: "draft", operation: "complete", productionTrace, proposedActions: [],
    }).success).toBe(false);
    const mismatched = {
      jobId: "j1", stage: "draft", operation: "complete", editorialPlanId: "plan-1",
      editorialPlanDigest: "a".repeat(64), editorialItemId: "item-1", briefId: "brief-1",
      productionTrace, proposedActions: [{ id: "a1", type: "publish_x_post", title: "post", description: "d", payload: { type: "publish_x_post", text: "changed copy" } }],
    };
    expect(draftsSubmissionSchema.safeParse(mismatched).success).toBe(false);
    expect(draftsSubmissionSchema.safeParse({ ...mismatched, proposedActions: [{ ...mismatched.proposedActions[0], payload: { type: "export_content_pack" } }] }).success).toBe(false);
    const changedAccepted = {
      ...productionTrace,
      acceptedDraft: { ...productionTrace.acceptedDraft, text: "mutated after review" },
    };
    expect(draftsSubmissionSchema.safeParse({
      ...mismatched, productionTrace: changedAccepted,
      proposedActions: [{ ...mismatched.proposedActions[0], payload: { type: "publish_x_post", text: "mutated after review" } }],
    }).success).toBe(false);
  });

  it("preserves additive visual grounding on analyzed moments", () => {
    const parsed = analysisSubmissionSchema.parse({
      jobId: "j1",
      stage: "understand",
      summary: "Visible product demo",
      moments: [{
        id: "m1", title: "Dashboard reveal", startSec: 2, endSec: 9,
        hook: "Watch the state change", quote: "The workflow is now live",
        visualHook: "Dashboard counter changes from zero to one",
        cropSuitability: "excellent",
        captionSafeRegion: "lower third",
        visualEvidenceIds: ["f1"],
      }],
      angles: [],
      strategy: { objective: "Teach the launch lesson", audience: "startup operators", pillars: ["product proof"], cadence: "one approved post", kpis: ["verified engagement"], briefs: [{ title: "Dashboard reveal", objective: "Show the state change", sourceRefs: ["m1"] }] },
      modelUsed: "gemini-3.5-flash",
    });

    expect(parsed.moments[0].visualEvidenceIds).toEqual(["f1"]);
    expect(parsed.moments[0].cropSuitability).toBe("excellent");
  });

  it("accepts bounded Veo and Lyria action contracts", () => {
    const parsed = draftsSubmissionSchema.safeParse({
      jobId: "j1", stage: "draft", productionTrace,
      operation: "complete",
      editorialPlanId: "plan-1", editorialItemId: "item-1", briefId: "brief-1",
      editorialPlanDigest: "a".repeat(64),
      proposedActions: [
        { id: "publish1", type: "publish_x_post", title: "post", description: "d",
          payload: { type: "publish_x_post", text: "hello world" } },
        { id: "veo1", type: "generate_veo_broll", title: "b-roll", description: "d",
          momentId: "m1", payload: { type: "generate_veo_broll", prompt: "abstract launch",
            durationSec: 4, aspectRatio: "9:16" } },
        { id: "lyria1", type: "generate_lyria_soundtrack", title: "music", description: "d",
          payload: { type: "generate_lyria_soundtrack", prompt: "instrumental startup pulse",
            durationSec: 30 } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects receipts for unknown action types", () => {
    const parsed = receiptSubmissionSchema.safeParse({
      jobId: "j1", actionId: "a1", actionType: "github_upsert_file",
      idempotencyKey: "k".repeat(32), operationId: "j1:publish:a1",
      traceId: "a".repeat(32), outcome: "applied", detail: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("requires durable verification lineage metadata", () => {
    const result = {
      target: "content-pack", actionId: "a1", receiptId: "r1",
      operationId: "j1:verify:a1", traceId: "a".repeat(32),
      verified: true, method: "artifact_digest_reread",
      evidence: { kind: "firestore_doc", url: "", fetchedAt: "2026-08-25T00:00:00Z", digest: "b".repeat(64) },
    };
    expect(verificationSubmissionSchema.safeParse({ jobId: "j1", results: [result] }).success).toBe(true);
    expect(verificationSubmissionSchema.safeParse({
      jobId: "j1", results: [{ ...result, receiptId: undefined }],
    }).success).toBe(false);
    expect(verificationSubmissionSchema.safeParse({
      jobId: "j1", results: [{ ...result, traceId: "0".repeat(32) }],
    }).success).toBe(false);
  });

  it("accepts strict budget reservations and usage records", () => {
    const modelPolicy = {
      policyVersion: "gear-2026-08-24", pricingVersion: "2026-08-23",
      temperature: 0.2, topP: 0.9, topK: null,
      safetyProfile: "harmonia-standard", maxOutputTokens: 2048,
      timeoutSeconds: 120, eligibleTasks: ["analyze_media"],
      minimumPassRate: "0.95",
    };
    expect(budgetReservationSchema.safeParse({
      jobId: "j1", operationId: "j1:draft:nimi:0", stage: "draft",
      role: "nimi", model: "gemini-3.5-flash",
      estimatedCostUsd: "0.001000", pricingVersion: "2026-08-23",
      modelPolicy,
    }).success).toBe(true);
    expect(usageRecordSchema.safeParse({
      id: "u1", jobId: "j1", operationId: "j1:draft:nimi:0", stage: "draft",
      role: "nimi", model: "gemini-3.5-flash", inputUnits: 100, outputUnits: 10,
      unitType: "tokens", estimatedCostUsd: "0.000240",
      pricingVersion: "2026-08-23", traceId: "a".repeat(32),
      modelPolicy,
      createdAt: "2026-08-23T12:00:00+00:00",
    }).success).toBe(true);
  });

  it("accepts only explicit no-call release or uncertain reservation outcomes", () => {
    expect(budgetReservationResolutionSchema.safeParse({
      jobId: "j1", operationId: "j1:draft:nimi:0", outcome: "not_invoked",
      reason: "provider validation failed before request dispatch",
    }).success).toBe(true);
    expect(budgetReservationResolutionSchema.safeParse({
      jobId: "j1", operationId: "j1:draft:nimi:0", outcome: "uncertain",
      reason: "request timed out after dispatch",
    }).success).toBe(true);
    expect(budgetReservationResolutionSchema.safeParse({
      jobId: "j1", operationId: "j1:draft:nimi:0", outcome: "released",
      reason: "ambiguous",
    }).success).toBe(false);
  });

  it("requires opaque tokens and bounded outcomes for stage execution leases", () => {
    expect(stageExecutionClaimSchema.safeParse({
      jobId: "j1", stage: "draft", ownerId: "worker-1", claimToken: "s".repeat(32),
    }).success).toBe(true);
    expect(stageExecutionFinalizeSchema.safeParse({
      jobId: "j1", stage: "draft", claimToken: "s".repeat(32), outcome: "applied",
    }).success).toBe(true);
    expect(stageExecutionFinalizeSchema.safeParse({
      jobId: "j1", stage: "draft", claimToken: "short", outcome: "retry",
    }).success).toBe(false);
  });

  it("rejects unpriced-looking amounts and malformed trace ids", () => {
    expect(budgetReservationSchema.safeParse({
      jobId: "j1", operationId: "op", stage: "draft", role: "nimi", model: "m",
      estimatedCostUsd: "free", pricingVersion: "2026-08-23",
    }).success).toBe(false);
    expect(usageRecordSchema.safeParse({
      id: "u1", jobId: "j1", operationId: "op", stage: "draft", role: "nimi",
      model: "m", inputUnits: 1, outputUnits: 1, unitType: "tokens",
      estimatedCostUsd: "0.01", pricingVersion: "2026-08-23", traceId: "short",
      createdAt: "2026-08-23T12:00:00+00:00",
    }).success).toBe(false);
  });

  it("requires a complete typed failure envelope", () => {
    const valid = {
      jobId: "j1", stage: "draft", category: "provider_transient",
      code: "provider_timeout", publicMessage: "The provider timed out.",
      retryable: true, operationId: "j1:draft:0", traceId: "a".repeat(32),
      attempt: 0, maxAttempts: 3, details: { exceptionType: "ReadTimeout" },
    };
    expect(failureSubmissionSchema.safeParse(valid).success).toBe(true);
    expect(failureSubmissionSchema.safeParse({ ...valid, error: "token=secret" }).success).toBe(false);
    expect(failureSubmissionSchema.safeParse({ ...valid, category: "mystery" }).success).toBe(false);
    expect(failureSubmissionSchema.safeParse({ ...valid, details: { responseBody: "secret" } }).success).toBe(false);
  });
});
