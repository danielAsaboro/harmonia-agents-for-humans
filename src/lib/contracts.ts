import { z } from "zod";

export const evidenceRefSchema = z.object({
  kind: z.enum([
    "youtube_api",
    "media_file",
    "gemini_call",
    "x_api",
    "firestore_doc",
    "http_probe",
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
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  hook: z.string().min(1),
  quote: z.string().min(1),
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
        type: z.enum(["publish_x_post", "export_content_pack"]),
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
        ]),
      }),
    )
    .max(12)
    .default([]),
});

export const receiptSubmissionSchema = z.object({
  jobId: z.string().min(1),
  actionId: z.string().min(1),
  actionType: z.enum(["export_content_pack", "publish_x_post"]),
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

export const failureSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.string().min(1),
  error: z.string().min(1),
  permanent: z.boolean(),
});
