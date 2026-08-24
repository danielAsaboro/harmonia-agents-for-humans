import { describe, expect, it } from "vitest";
import {
  analysisSubmissionSchema,
  budgetReservationSchema,
  draftsSubmissionSchema,
  failureSubmissionSchema,
  ingestSubmissionSchema,
  receiptSubmissionSchema,
  usageRecordSchema,
} from "@/lib/contracts";

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
      drafts: [{ id: "d1", platform: "x", text: "hello world" }],
      proposedActions: [
        { id: "a1", type: "publish_x_post", title: "post", description: "d",
          payload: { type: "publish_x_post", text: "hello world" } },
        { id: "a2", type: "export_content_pack", title: "pack", description: "d",
          payload: { type: "export_content_pack" } },
      ],
    });
    expect(parsed.success).toBe(true);
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
      modelUsed: "gemini-3.5-flash",
    });

    expect(parsed.moments[0].visualEvidenceIds).toEqual(["f1"]);
    expect(parsed.moments[0].cropSuitability).toBe("excellent");
  });

  it("accepts bounded Veo and Lyria action contracts", () => {
    const parsed = draftsSubmissionSchema.safeParse({
      jobId: "j1", stage: "draft", drafts: [],
      proposedActions: [
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
