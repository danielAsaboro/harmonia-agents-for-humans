import { z } from "zod";

const usdDecimalSchema = z.string().regex(/^\d+\.\d{1,6}$/);

const modelPolicySchema = z.object({
  policyVersion: z.string().min(1),
  pricingVersion: z.string().min(1),
  temperature: z.number().min(0).max(2),
  topP: z.number().positive().max(1).nullable(),
  topK: z.number().int().positive().nullable(),
  safetyProfile: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
  eligibleTasks: z.array(z.string().min(1)).min(1),
  minimumPassRate: z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/),
}).strict();

export const budgetReservationSchema = z.object({
  jobId: z.string().min(1),
  operationId: z.string().min(1),
  stage: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  estimatedCostUsd: usdDecimalSchema,
  pricingVersion: z.string().min(1),
  modelPolicy: modelPolicySchema.optional(),
}).strict();

export const budgetReservationResolutionSchema = z.object({
  jobId: z.string().min(1),
  operationId: z.string().min(1),
  outcome: z.enum(["not_invoked", "uncertain"]),
  reason: z.string().min(10).max(500),
}).strict();

export const stageExecutionClaimSchema = z.object({
  jobId: z.string().min(1),
  stage: z.string().min(1),
  ownerId: z.string().min(1).max(200),
  claimToken: z.string().min(32).max(256),
}).strict();

export const stageExecutionFinalizeSchema = z.object({
  jobId: z.string().min(1),
  stage: z.string().min(1),
  claimToken: z.string().min(32).max(256),
  outcome: z.enum(["applied", "failed", "uncertain"]),
  failureReason: z.string().min(1).max(500).optional(),
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
  unitType: z.enum(["tokens", "images", "video_seconds", "audio_seconds", "endpoint_seconds", "media_generations"]),
  estimatedCostUsd: usdDecimalSchema,
  observedCostUsd: usdDecimalSchema.optional(),
  pricingVersion: z.string().min(1),
  modelPolicy: modelPolicySchema.optional(),
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

const evidenceRefs = z.array(z.string().min(1).max(100)).min(1).max(12);
const funnelStage = z.enum(["awareness", "consideration", "conversion", "retention", "advocacy"]);
export const strategyContextSchema = z.object({
  company: z.string().min(1).max(200), product: z.string().min(1).max(500), positioning: z.string().min(1).max(500),
  differentiators: z.array(z.string().min(1).max(300)).min(1).max(8), brandVoice: z.array(z.string().min(1).max(120)).min(1).max(8),
  exclusions: z.array(z.string().min(1).max(300)).max(12).default([]), safetyConstraints: z.array(z.string().min(1).max(300)).max(12).default([]),
  businessObjectives: z.array(z.string().min(1).max(300)).min(1).max(8), campaignObjectives: z.array(z.string().min(1).max(300)).min(1).max(8),
  audiences: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200), pains: z.array(z.string().min(1).max(300)).min(1).max(8) }).strict()).min(1).max(6),
  funnelStage, intendedConversion: z.string().min(1).max(300), requestedChannels: z.array(z.string().min(1).max(100)).min(1).max(8),
  supportedChannels: z.array(z.string().min(1).max(100)).min(1).max(8), horizonWeeks: z.number().int().min(1).max(12).default(4),
}).strict();
export const contentStrategySchema = z.object({
  strategyId: z.string().min(1).max(100), version: z.number().int().min(1).max(2), horizonWeeks: z.number().int().min(1).max(12),
  thesis: z.string().min(1).max(600), differentiatedNarrative: z.string().min(1).max(600),
  objectives: z.array(z.object({ text: z.string().min(1).max(600), evidenceRefs }).strict()).min(1).max(8),
  audiencePriorities: z.array(z.object({ audienceId: z.string().min(1).max(100), priority: z.number().int().min(1).max(5), reason: z.string().min(1).max(500), evidenceRefs }).strict()).min(1).max(6),
  funnelIntent: funnelStage, intendedConversions: z.array(z.string().min(1).max(300)).min(1).max(6),
  pillars: z.array(z.object({ name: z.string().min(1).max(200), purpose: z.string().min(1).max(500), evidenceRefs }).strict()).min(1).max(8),
  campaignThemes: z.array(z.object({ name: z.string().min(1).max(200), message: z.string().min(1).max(500), evidenceRefs }).strict()).min(1).max(8),
  channelRoles: z.array(z.object({ channel: z.string().min(1).max(100), role: z.string().min(1).max(300), operationallySupported: z.boolean(), formats: z.array(z.string().min(1).max(100)).min(1).max(8), cadence: z.string().min(1).max(200), evidenceRefs }).strict()).min(1).max(8),
  contentMix: z.array(z.object({ format: z.string().min(1).max(100), percentage: z.number().int().min(1).max(100) }).strict()).min(1).max(8).refine((items) => items.reduce((sum, item) => sum + item.percentage, 0) === 100, "content mix must total 100"),
  cadenceGuidance: z.string().min(1).max(300), priorityRules: z.array(z.string().min(1).max(300)).min(1).max(8), ctaGuidance: z.array(z.string().min(1).max(300)).min(1).max(8),
  kpis: z.array(z.object({ name: z.string().min(1).max(200), target: z.string().min(1).max(200), measurement: z.string().min(1).max(300), evidenceRefs }).strict()).min(1).max(8),
  successCriteria: z.array(z.string().min(1).max(300)).min(1).max(8), constraints: z.array(z.string().min(1).max(300)).max(12), exclusions: z.array(z.string().min(1).max(300)).max(12), brandSafety: z.array(z.string().min(1).max(300)).max(12),
  briefs: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().min(1).max(300), objective: z.string().min(1).max(600), audienceId: z.string().min(1).max(100), funnelStage, keyMessage: z.string().min(1).max(600), channelCandidates: z.array(z.string().min(1).max(100)).min(1).max(8), formatCandidates: z.array(z.string().min(1).max(100)).min(1).max(8), ctaIntent: z.string().min(1).max(300), intendedConversion: z.string().min(1).max(300), kpi: z.string().min(1).max(200), priority: z.number().int().min(1).max(5), dependencies: z.array(z.string().min(1).max(300)).max(8), constraints: z.array(z.string().min(1).max(300)).max(12), evidenceRefs }).strict()).min(1).max(10),
  assumptions: z.array(z.object({ text: z.string().min(1).max(500), evidenceRefs, confidence: z.enum(["low", "medium", "high"]) }).strict()).max(8),
  confidence: z.enum(["low", "medium", "high"]),
}).strict();

const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => /(?:Z|[+-]00:00)$/.test(value),
  "timestamp must be UTC",
);

const instant = (value: string) => Date.parse(value);

const ianaTimezoneSchema = z.string().min(1).max(100).superRefine((value, ctx) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    ctx.addIssue({ code: "custom", message: "timezone must be a valid IANA timezone" });
  }
});

const strategyApprovalRecordSchema = z.object({
  decision: z.literal("approved"),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  revision: z.number().int().min(1).max(2),
  actorSubjectId: z.string().min(1).max(200),
  decidedAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
  feedback: z.string().max(2000).optional(),
}).strict();

const channelCapabilitySchema = z.object({
  channel: z.string().min(1).max(100),
  formats: z.array(z.string().min(1).max(100)).min(1).max(8),
}).strict();

const editorialCommitmentSchema = z.object({
  id: z.string().min(1).max(100),
  channel: z.string().min(1).max(100),
  publicationWindowStartAt: utcTimestampSchema,
  publicationWindowEndAt: utcTimestampSchema,
}).strict().refine(
  (commitment) => instant(commitment.publicationWindowStartAt) < instant(commitment.publicationWindowEndAt),
  "publication window must increase",
);

const productionCapacitySchema = z.object({
  maxItems: z.number().int().min(1).max(48),
  maxItemsPerWeek: z.number().int().min(1).max(12),
}).strict();

const cadenceConstraintsSchema = z.object({
  minimumHoursBetweenItems: z.number().int().min(0).max(168),
  maxItemsPerChannelPerWeek: z.number().int().min(1).max(12),
}).strict();

const postingWindowObservationSchema = z.object({
  id: z.string().min(1).max(100),
  channel: z.string().min(1).max(100),
  format: z.string().min(1).max(100),
  observedAt: utcTimestampSchema,
  evidenceRefs,
}).strict();

const strictMomentSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), startSec: z.number().nonnegative(), endSec: z.number().nonnegative(),
  hook: z.string().min(1), quote: z.string().min(1), visualHook: z.string().max(500).optional(),
  cropSuitability: z.enum(["poor", "fair", "good", "excellent"]).optional(), captionSafeRegion: z.string().max(200).optional(),
  visualEvidenceIds: z.array(z.string().min(1)).max(12).default([]),
}).strict();

const strictAngleSchema = z.object({
  id: z.string().min(1), kind: z.enum(["trend", "meme"]), title: z.string().min(1), rationale: z.string().min(1),
}).strict();

const analysisResultSchema = z.object({
  summary: z.string().min(1), moments: z.array(strictMomentSchema).max(12).default([]), angles: z.array(strictAngleSchema).max(12).default([]),
}).strict();

export const editorialPlannerInputSchema = z.object({
  strategy: contentStrategySchema,
  strategyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  strategyVersion: z.number().int().min(1).max(2),
  strategyApproval: strategyApprovalRecordSchema,
  analysis: analysisResultSchema,
  horizonStartAt: utcTimestampSchema,
  horizonEndAt: utcTimestampSchema,
  timezone: ianaTimezoneSchema,
  channelCapabilities: z.array(channelCapabilitySchema).min(1).max(8),
  existingCommitments: z.array(editorialCommitmentSchema).max(48).default([]),
  productionCapacity: productionCapacitySchema,
  cadenceConstraints: cadenceConstraintsSchema,
  postingWindowObservations: z.array(postingWindowObservationSchema).max(24).default([]),
  revision: z.number().int().min(1).max(2),
  replanningFeedback: z.string().max(2000).optional(),
}).strict().refine(
  (input) => instant(input.horizonStartAt) < instant(input.horizonEndAt),
  "editorial horizon must increase",
);

export const editorialPlanItemSchema = z.object({
  id: z.string().min(1).max(100), briefId: z.string().min(1).max(100),
  campaignTheme: z.string().min(1).max(200), contentPillar: z.string().min(1).max(200), objective: z.string().min(1).max(600),
  audienceId: z.string().min(1).max(100), funnelStage, intendedConversion: z.string().min(1).max(300), ctaIntent: z.string().min(1).max(300), kpi: z.string().min(1).max(200),
  channel: z.string().min(1).max(100), format: z.string().min(1).max(100), evidenceRefs,
  publicationWindowStartAt: utcTimestampSchema, publicationWindowEndAt: utcTimestampSchema, productionDeadlineAt: utcTimestampSchema,
  priority: z.number().int().min(1).max(5), selectionScore: z.number().min(0).max(1), dependencies: z.array(z.string().min(1).max(100)).max(8).default([]),
  productionStatus: z.literal("planned"), constraints: z.array(z.string().min(1).max(300)).max(12).default([]), requiredAssets: z.array(z.string().min(1).max(300)).max(12).default([]),
  planningRationale: z.string().min(1).max(600), selectionRationale: z.string().min(1).max(600), confidence: z.enum(["low", "medium", "high"]),
}).strict().refine(
  (item) => instant(item.publicationWindowStartAt) < instant(item.publicationWindowEndAt),
  "publication window must increase",
).refine(
  (item) => instant(item.productionDeadlineAt) <= instant(item.publicationWindowStartAt),
  "production deadline must be before the publication window",
);

export const editorialPlanSchema = z.object({
  planId: z.string().min(1).max(100), version: z.number().int().min(1).max(2), approvedStrategyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  horizonStartAt: utcTimestampSchema, horizonEndAt: utcTimestampSchema, timezone: ianaTimezoneSchema,
  summary: z.string().min(1).max(1000), sequencingRationale: z.string().min(1).max(1000), cadenceRationale: z.string().min(1).max(1000),
  assumptions: z.array(z.string().min(1).max(500)).max(12).default([]), confidence: z.enum(["low", "medium", "high"]),
  items: z.array(editorialPlanItemSchema).min(1).max(48), selectedNextItemId: z.string().min(1).max(100),
}).strict().refine(
  (plan) => instant(plan.horizonStartAt) < instant(plan.horizonEndAt),
  "editorial horizon must increase",
).refine(
  (plan) => plan.items.filter((item) => item.id === plan.selectedNextItemId).length === 1,
  "selectedNextItemId must identify exactly one plan item",
);

export const productionDraftInputSchema = z.object({
  planId: z.string().min(1).max(100), strategyDigest: z.string().regex(/^[0-9a-f]{64}$/), editorialItem: editorialPlanItemSchema,
  brief: contentStrategySchema.shape.briefs.element,
  referencedMoments: z.array(strictMomentSchema).max(12).default([]), referencedAngles: z.array(strictAngleSchema).max(12).default([]),
  brandContext: z.string().min(1).max(4000), constraints: z.array(z.string().min(1).max(300)).max(24).default([]),
}).strict().superRefine((input, context) => {
  if (input.brief.id !== input.editorialItem.briefId) {
    context.addIssue({ code: "custom", message: "production input must contain the exact selected brief" });
  }
  const exactFields = ["objective", "audienceId", "funnelStage", "intendedConversion", "ctaIntent", "kpi"] as const;
  if (exactFields.some((field) => input.brief[field] !== input.editorialItem[field])) {
    context.addIssue({ code: "custom", message: "production input brief does not match the selected editorial item" });
  }
  if ([...input.brief.evidenceRefs].sort().join("\0") !== [...input.editorialItem.evidenceRefs].sort().join("\0")) {
    context.addIssue({ code: "custom", message: "production input brief evidence does not match the selected editorial item" });
  }
  const itemEvidence = new Set(input.editorialItem.evidenceRefs);
  const supplied = [...input.referencedMoments, ...input.referencedAngles].map((item) => item.id);
  if (supplied.length === 0 || supplied.some((id) => !itemEvidence.has(id))) {
    context.addIssue({ code: "custom", message: "production input contains unreferenced evidence" });
  }
});

export const strategySubmissionSchema = z.object({
  jobId: z.string().min(1), stage: z.literal("strategize"), revision: z.number().int().min(1).max(2),
  strategy: contentStrategySchema, modelUsed: z.string().min(1),
}).strict();

export const editorialPlanSubmissionSchema = z.object({
  jobId: z.string().min(1), stage: z.literal("plan"), revision: z.number().int().min(1).max(2),
  plan: editorialPlanSchema, modelUsed: z.string().min(1),
}).strict();

export const strategyInvocationContextSchema = z.object({
  jobId: z.string().min(1), stage: z.literal("strategize"), revision: z.number().int().min(1).max(2),
  sourceIds: z.array(z.string().min(1).max(100)).min(1).max(24),
  operatorContextIds: z.array(z.string().min(1).max(100)).length(2),
  performance: z.array(z.object({ id: z.string().min(1).max(100), firestoreEvidenceRef: z.string().min(1).max(500) }).strict()).max(12),
  memoryFacts: z.array(z.object({ id: z.string().min(1).max(100), firestoreEvidenceRef: z.string().min(1).max(500) }).strict()).max(5),
  audienceIds: z.array(z.string().min(1).max(100)).min(1).max(6),
  requestedChannels: z.array(z.string().min(1).max(100)).min(1).max(8),
  supportedChannels: z.array(z.string().min(1).max(100)).min(1).max(8),
  horizonWeeks: z.number().int().min(1).max(12),
}).strict();

export const draftSchema = z.object({
  id: z.string().min(1),
  platform: z.enum(["x"]),
  momentId: z.string().optional(),
  angleId: z.string().optional(),
  text: z.string().min(1),
});

export const draftClaimSubmissionSchema = z.object({
  jobId: z.string().min(1), stage: z.literal("draft"), operation: z.literal("claim"),
  editorialPlanId: z.string().min(1).max(100), editorialPlanDigest: z.string().regex(/^[0-9a-f]{64}$/),
  editorialItemId: z.string().min(1).max(100), briefId: z.string().min(1).max(100),
}).strict();

export const draftCompletionSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("draft"),
  operation: z.literal("complete"),
  editorialPlanId: z.string().min(1).max(100),
  editorialPlanDigest: z.string().regex(/^[0-9a-f]{64}$/),
  editorialItemId: z.string().min(1).max(100),
  briefId: z.string().min(1).max(100),
  drafts: z.array(draftSchema).max(10).default([]),
  proposedActions: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum([
          "publish_x_post",
          "export_content_pack",
          "generate_image",
          "generate_veo_broll",
          "generate_lyria_soundtrack",
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
            type: z.literal("generate_veo_broll"),
            prompt: z.string().min(1).max(2000),
            durationSec: z.literal(4),
            aspectRatio: z.enum(["16:9", "9:16"]),
          }),
          z.object({
            type: z.literal("generate_lyria_soundtrack"),
            prompt: z.string().min(1).max(2000),
            durationSec: z.literal(30),
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
    .max(20)
    .default([]),
});

export const receiptSubmissionSchema = z.object({
  commandId: z.string().min(1).optional(),
  jobId: z.string().min(1),
  actionId: z.string().min(1),
  actionType: z.enum([
    "export_content_pack",
    "publish_x_post",
    "generate_image",
    "generate_veo_broll",
    "generate_lyria_soundtrack",
    "render_clip",
    "render_reel",
  ]),
  idempotencyKey: z.string().min(16),
  operationId: z.string().min(1).max(240),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  claimToken: z.string().min(1).max(240),
  outcome: z.enum(["applied", "already_applied", "rejected", "failed"]),
  artifact: evidenceRefSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export const effectClaimSubmissionSchema = z.object({
  commandId: z.string().min(1).optional(),
  jobId: z.string().min(1),
  actionId: z.string().min(1),
  actionType: z.enum([
    "export_content_pack", "publish_x_post", "generate_image",
    "generate_veo_broll", "generate_lyria_soundtrack", "render_clip", "render_reel",
  ]),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().min(1).max(240),
  traceId: z.string().regex(/^[a-f0-9]{32}$/).refine((value) => value !== "0".repeat(32)),
  claimToken: z.string().min(1).max(240),
});

export const mediaOperationSchema = z.object({
  provider: z.enum(["veo", "lyria"]),
  operationName: z.string().min(1).max(1000),
});

export const verificationSubmissionSchema = z.object({
  jobId: z.string().min(1),
  results: z.array(
    z.object({
      target: z.string().min(1),
      actionId: z.string().min(1),
      receiptId: z.string().min(1),
      operationId: z.string().min(1).max(240),
      traceId: z.string().regex(/^[a-f0-9]{32}$/).refine((value) => value !== "0".repeat(32)),
      verified: z.boolean(),
      method: z.enum(["artifact_digest_reread", "official_api_readback"]),
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
  category: z.enum([
    "validation", "authorization", "policy", "budget",
    "provider_transient", "provider_permanent", "dependency", "protocol",
  ]),
  code: z.string().regex(/^[a-z0-9_]+$/).max(80),
  publicMessage: z.string().min(1).max(240),
  retryable: z.boolean(),
  operationId: z.string().min(1).max(240),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().min(1).max(10),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).superRefine((details, ctx) => {
    for (const key of Object.keys(details)) {
      if (/(body|content|cookie|prompt|response|secret|text|token|transcript)/i.test(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "content-bearing failure detail is forbidden" });
      }
    }
  }),
}).strict();

export const draftsSubmissionSchema = z.discriminatedUnion("operation", [
  draftClaimSubmissionSchema, draftCompletionSubmissionSchema,
]);

export type FailureSubmission = z.infer<typeof failureSubmissionSchema>;
