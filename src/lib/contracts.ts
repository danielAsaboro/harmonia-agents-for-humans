import { z } from "zod";

const usdDecimalSchema = z.string().regex(/^\d+\.\d{1,6}$/);

export const budgetReservationSchema = z.object({
  jobId: z.string().min(1),
  operationId: z.string().min(1),
  stage: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  estimatedCostUsd: usdDecimalSchema,
  pricingVersion: z.string().min(1),
}).strict();

export const usageRecordSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  operationId: z.string().min(1),
  stage: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  inputUnits: z.number().int().nonnegative(),
  outputUnits: z.number().int().nonnegative(),
  unitType: z.enum(["tokens", "images", "video_seconds", "audio_seconds", "endpoint_seconds"]),
  estimatedCostUsd: usdDecimalSchema,
  observedCostUsd: usdDecimalSchema.optional(),
  pricingVersion: z.string().min(1),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const evidenceRefSchema = z.object({
  kind: z.enum([
    "youtube_api",
    "media_file",
    "gemini_call",
    "x_api",
    "firestore_doc",
    "http_probe",
    "asset_store",
  ]),
  url: z.string(),
  fetchedAt: z.string(),
  digest: z.string().nullable().optional(),
});

export const ingestSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("ingest"),
  videoId: z.string().min(1),
  title: z.string().min(1),
  channel: z.string().min(1),
  durationSec: z.number().int().positive(),
  mediaBytes: z.number().int().nonnegative(),
  mediaDigest: z.string().min(16),
  thumbnailUrl: z.string().optional(),
});

export const transcriptSegmentSchema = z.object({
  id: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string().min(1),
});

export const transcriptSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("transcribe"),
  language: z.string().default("en"),
  segments: z.array(transcriptSegmentSchema).min(1),
  modelUsed: z.string().min(1),
});

export const momentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  // Concept/brief jobs carry key points with zero timestamps (no media
  // timeline), so 0 is a valid boundary here.
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  hook: z.string().min(1),
  quote: z.string().min(1),
  visualHook: z.string().max(500).optional(),
  cropSuitability: z.enum(["poor", "fair", "good", "excellent"]).optional(),
  captionSafeRegion: z.string().max(200).optional(),
  visualEvidenceIds: z.array(z.string().min(1)).max(12).default([]),
});

export const angleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["trend", "meme"]),
  title: z.string().min(1),
  rationale: z.string().min(1),
});

export const analysisSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("understand"),
  moments: z.array(momentSchema).max(12).default([]),
  angles: z.array(angleSchema).max(12).default([]),
  summary: z.string().min(1),
  modelUsed: z.string().min(1),
});

export const draftSchema = z.object({
  id: z.string().min(1),
  platform: z.enum(["x"]),
  momentId: z.string().optional(),
  angleId: z.string().optional(),
  text: z.string().min(1),
});

export const draftsSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("draft"),
  drafts: z.array(draftSchema).max(10).default([]),
  proposedActions: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum([
          "publish_x_post",
          "export_content_pack",
          "generate_image",
          "render_clip",
          "render_reel",
        ]),
        title: z.string().min(1),
        description: z.string().min(1),
        momentId: z.string().optional(),
        angleId: z.string().optional(),
        payload: z.union([
          z.object({
            type: z.literal("publish_x_post"),
            text: z.string().min(1),
          }),
          z.object({ type: z.literal("export_content_pack") }),
          z.object({
            type: z.literal("generate_image"),
            prompt: z.string().min(1).max(4000),
          }),
          z.object({
            type: z.literal("render_clip"),
            momentId: z.string().min(1),
            format: z.enum(["vertical", "square", "native"]).default("vertical"),
            captions: z.boolean().default(true),
          }),
          z.object({
            type: z.literal("render_reel"),
            momentIds: z.array(z.string().min(1)).min(2).max(6),
            format: z.enum(["vertical", "square", "native"]).default("vertical"),
            captions: z.boolean().default(true),
          }),
        ]),
      }),
    )
    .max(12)
    .default([]),
});

export const receiptSubmissionSchema = z.object({
  jobId: z.string().min(1),
  actionId: z.string().min(1),
  actionType: z.enum([
    "export_content_pack",
    "publish_x_post",
    "generate_image",
    "render_clip",
    "render_reel",
  ]),
  idempotencyKey: z.string().min(16),
  outcome: z.enum(["applied", "already_applied", "rejected", "failed"]),
  artifact: evidenceRefSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export const verificationSubmissionSchema = z.object({
  jobId: z.string().min(1),
  results: z.array(
    z.object({
      target: z.string().min(1),
      verified: z.boolean(),
      method: z.string().min(1),
      evidence: evidenceRefSchema,
      note: z.string().optional(),
    }),
  ),
});

export const proposalSubmissionSchema = z.object({
  proposals: z
    .array(
      z.object({
        id: z.string().min(6).max(40),
        source: z.enum(["trend_scan", "engagement_watch", "calendar_gap", "recycle"]),
        topic: z.string().min(4).max(300),
        angle: z.string().max(300).default(""),
        reason: z.string().max(600).default(""),
        sources: z.array(z.string().url()).max(5).default([]),
        suggestedPost: z.string().max(280).default(""),
      }),
    )
    .min(1)
    .max(10),
});

export const proposalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
});

export const engagementRecordSchema = z.object({
  actionId: z.string().min(1),
  postId: z.string().min(1),
  url: z.string().optional(),
  likes: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  reposts: z.number().int().nonnegative(),
  quotes: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative().optional(),
});

export const engagementSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("learn"),
  engagement: z.array(engagementRecordSchema).max(20).default([]),
  learnings: z.object({
    summary: z.string().min(1),
    notes: z.array(z.string()).max(10).default([]),
  }),
});

export const failureSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.string().min(1),
  error: z.string().min(1),
  permanent: z.boolean(),
});
