import { createHash } from "node:crypto";
import { z } from "zod";
import { operatorInstructionContextSchema, type OperatorInstructionContext } from "./operatorInstructions";

const usd = z.string().regex(/^\d+\.\d{6}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const artifactId = z.string().uuid();

export const verifiedProductionArtifactRefSchema = z.object({
  artifactId,
  digest,
  mime: z.enum(["video/mp4", "audio/mpeg", "audio/wav", "image/jpeg", "image/png"]),
  sizeBytes: z.number().int().positive().max(64 * 1024 * 1024),
  rightsAuthorizationId: z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),
}).strict();
export type VerifiedProductionArtifactRef = z.infer<typeof verifiedProductionArtifactRefSchema>;

export const NOVA_REEL_CAPABILITIES = {
  "nova-reel": { model: "amazon.nova-reel-v1:1", resolutions: ["720p"], durations: [6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90, 96, 102, 108, 114, 120], modes: ["text_to_video", "image_to_video"], usdPerSecond: null, preview: false },
} as const;
export const ELEVENLABS_CAPABILITIES = {
  "elevenlabs-music": { model: "music_v1", durations: [30], maximumDurationSec: 600, instrumental: true, usdPerSecond: null, preview: false },
} as const;
export const NOVA_CANVAS_CAPABILITIES = {
  "nova-canvas": { model: "amazon.nova-canvas-v1:0", resolutions: ["1024x1024"], outputCount: 1, preview: false },
} as const;
export const generatedImageSpecSchema = z.object({
  modelCapability: z.literal("nova-canvas"),
  prompt: z.string().min(1).max(4000),
  width: z.literal(1024),
  height: z.literal(1024),
  outputCount: z.literal(1),
}).strict();
export const generatedVideoSpecSchema = z.object({
  modelCapability: z.literal("nova-reel"),
  mode: z.enum(["text_to_video", "image_to_video"]),
  prompt: z.string().min(1).max(4000),
  sourceImageArtifact: verifiedProductionArtifactRefSchema.optional(),
  durationSec: z.number().int().min(6).max(120).multipleOf(6),
  aspectRatio: z.literal("16:9"),
  resolution: z.literal("720p"),
  seed: z.number().int().nonnegative().max(2147483646).optional(),
  outputCount: z.literal(1),
}).strict().superRefine((value, context) => {
  if ((value.mode === "image_to_video") !== Boolean(value.sourceImageArtifact)) context.addIssue({ code: "custom", path: ["sourceImageArtifact"], message: "image conditioning must match mode" });
  if (value.durationSec === 6 && value.prompt.length > 512) context.addIssue({ code: "custom", path: ["prompt"], message: "single-shot prompt must not exceed 512 characters" });
  if (value.durationSec > 6 && value.sourceImageArtifact) context.addIssue({ code: "custom", path: ["sourceImageArtifact"], message: "multi-shot video cannot include an input image" });
  const ref = value.sourceImageArtifact;
  if (ref && (!["image/jpeg", "image/png"].includes(ref.mime) || ref.sizeBytes > 20 * 1024 * 1024)) context.addIssue({ code: "custom", path: ["sourceImageArtifact"], message: "Nova Reel requires a JPEG or PNG up to 20 MB" });
});
export const generatedMusicSpecSchema = z.object({
  modelCapability: z.literal("elevenlabs-music"),
  prompt: z.string().min(1).max(4100),
  instrumental: z.literal(true),
  targetDurationSec: z.number().int().min(3).max(600).default(30),
  outputCount: z.literal(1),
}).strict();

/**
 * The provider and immutable model release are part of the approved request,
 * rather than executor defaults.  A worker may only submit this exact envelope.
 */
export const sealedProviderRequestSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("nova_canvas"), model: z.literal(NOVA_CANVAS_CAPABILITIES["nova-canvas"].model), request: generatedImageSpecSchema, instructionContext: operatorInstructionContextSchema.optional() }).strict(),
  z.object({ provider: z.literal("nova_reel"), model: z.literal(NOVA_REEL_CAPABILITIES["nova-reel"].model), request: generatedVideoSpecSchema, instructionContext: operatorInstructionContextSchema.optional() }).strict(),
  z.object({ provider: z.literal("elevenlabs"), model: z.literal(ELEVENLABS_CAPABILITIES["elevenlabs-music"].model), request: generatedMusicSpecSchema, instructionContext: operatorInstructionContextSchema.optional() }).strict(),
]);
export type SealedProviderRequest = z.infer<typeof sealedProviderRequestSchema>;

export function sealProviderRequest(spec: GeneratedVideoSpec | GeneratedMusicSpec | GeneratedImageSpec, instructionContext?: OperatorInstructionContext): SealedProviderRequest {
  const context = instructionContext ? { instructionContext: operatorInstructionContextSchema.parse(instructionContext) } : {};
  if (spec.modelCapability === "nova-canvas") return { provider: "nova_canvas", model: NOVA_CANVAS_CAPABILITIES["nova-canvas"].model, request: spec, ...context };
  if (spec.modelCapability === "nova-reel") return { provider: "nova_reel", model: NOVA_REEL_CAPABILITIES["nova-reel"].model, request: spec, ...context };
  return { provider: "elevenlabs", model: ELEVENLABS_CAPABILITIES["elevenlabs-music"].model, request: spec, ...context };
}

export function sealedProviderForOperation(operation: { executionAuthority: string; payload: unknown }): SealedProviderRequest | null {
  if (operation.executionAuthority !== "production_mandate") return null;
  return sealedProviderRequestSchema.parse(operation.payload);
}

const sourceWindowSchema = z.object({
  startSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
}).strict();

const reframeSchema = z.object({
  xPercent: z.number().min(0).max(100),
  yPercent: z.number().min(0).max(100),
  scale: z.number().min(1).max(4),
}).strict();

const captionSchema = z.object({
  id: identifier,
  startSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  text: z.string().min(1).max(500),
  sourceSegmentRefs: z.array(identifier).min(1).max(20),
}).strict();

const sceneSchema = z.object({
  id: identifier, order: z.number().int().positive(), startSec: z.number().nonnegative(), durationSec: z.number().positive(),
  purpose: z.string().min(1), sourceArtifact: verifiedProductionArtifactRefSchema.optional(), video: generatedVideoSpecSchema.optional(),
  sourceWindow: sourceWindowSchema.optional(), sourceSegmentRefs: z.array(identifier).min(1).max(100).optional(),
  preserveSourceAudio: z.boolean().optional(), reframe: reframeSchema.optional(),
  overlays: z.array(z.record(z.string(), z.unknown())), captions: z.array(captionSchema), transitions: z.array(z.record(z.string(), z.unknown())),
}).strict().superRefine((value, context) => {
  if (Boolean(value.sourceArtifact) === Boolean(value.video)) {
    context.addIssue({ code: "custom", path: ["sourceArtifact"], message: "scene requires exactly one verified source artifact or generated video" });
  }
  if (value.sourceArtifact && !value.sourceArtifact.mime.startsWith("video/")) {
    context.addIssue({ code: "custom", path: ["sourceArtifact", "mime"], message: "scene source artifact must be video" });
  }
  const sourceOnlyFields = [value.sourceWindow, value.sourceSegmentRefs, value.preserveSourceAudio, value.reframe];
  if (value.sourceArtifact) {
    if (!value.sourceWindow) context.addIssue({ code: "custom", path: ["sourceWindow"], message: "source artifact scene requires a sealed source window" });
    if (!value.sourceSegmentRefs?.length) context.addIssue({ code: "custom", path: ["sourceSegmentRefs"], message: "source artifact scene requires source segment lineage" });
    if (value.preserveSourceAudio === undefined) context.addIssue({ code: "custom", path: ["preserveSourceAudio"], message: "source artifact scene must seal source audio handling" });
    if (!value.reframe) context.addIssue({ code: "custom", path: ["reframe"], message: "source artifact scene requires a deterministic reframe" });
    if (value.sourceWindow && value.durationSec > value.sourceWindow.durationSec) {
      context.addIssue({ code: "custom", path: ["sourceWindow", "durationSec"], message: "source window must cover the authored scene duration" });
    }
    for (const [index, caption] of value.captions.entries()) {
      if (caption.startSec + caption.durationSec > value.durationSec) {
        context.addIssue({ code: "custom", path: ["captions", index], message: "caption extends beyond its scene window" });
      }
      if (caption.sourceSegmentRefs.some((id) => !value.sourceSegmentRefs?.includes(id))) {
        context.addIssue({ code: "custom", path: ["captions", index, "sourceSegmentRefs"], message: "caption lineage must be contained by scene source segment lineage" });
      }
    }
  } else if (sourceOnlyFields.some((field) => field !== undefined)) {
    context.addIssue({ code: "custom", path: ["sourceArtifact"], message: "source-only edit fields require a verified source artifact" });
  }
});

const narrationClipSchema = z.object({
  id: identifier,
  artifact: verifiedProductionArtifactRefSchema,
  startSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
}).strict().superRefine((value, context) => {
  if (!value.artifact.mime.startsWith("audio/")) {
    context.addIssue({ code: "custom", path: ["artifact", "mime"], message: "narration artifact must be audio" });
  }
});
const packTextChildSchema = z.object({ artifactId: z.string().min(1), digest, mime: z.enum(["text/markdown", "application/json"]) }).strict();

export const videoProductionPlanSchema = z.object({
  id: identifier, jobId: identifier, workspaceId: identifier, brandId: identifier, revision: z.number().int().positive(),
  goal: z.string().min(1), audience: z.string().min(1), tone: z.array(z.string().min(1)).min(1),
  target: z.object({ platform: z.string().min(1), durationSec: z.number().positive(), aspectRatio: z.enum(["16:9", "9:16"]), resolution: z.enum(["720p", "1080p", "4k"]), frameRate: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]), format: z.literal("mp4") }).strict(),
  scenes: z.array(sceneSchema), images: z.array(generatedImageSpecSchema).max(8).default([]), narration: z.array(narrationClipSchema).max(100), soundtrack: generatedMusicSpecSchema.optional(),
  constraints: z.object({ allowLikeness: z.boolean(), allowGeneratedVocals: z.boolean(), requireLicensedSources: z.boolean() }).strict(),
  pricingVersion: z.string().min(1), operationCostsUsd: z.record(z.string().regex(/^[A-Za-z0-9:_-]{1,512}$/), usd), estimatedCostUsd: usd, maximumCostUsd: usd,
  outputRequest: z.object({
    outputPlanId: identifier,
    outputPlanDigest: digest,
    outputIds: z.array(identifier).min(1).max(16),
    contentRevision: z.number().int().positive(),
    destinations: z.array(z.string().min(1).max(128)).max(16),
    promptDigest: digest,
  }).strict().optional(),
  instructionContext: operatorInstructionContextSchema.optional(),
  packTextChildren: z.array(packTextChildSchema).max(100).default([]),
}).strict().superRefine((value, context) => {
  if (Number(value.maximumCostUsd) < Number(value.estimatedCostUsd)) context.addIssue({ code: "custom", path: ["maximumCostUsd"], message: "maximum cost must cover estimated cost" });
  if (!value.constraints.allowGeneratedVocals && value.soundtrack && !value.soundtrack.instrumental) context.addIssue({ code: "custom", path: ["soundtrack"], message: "generated vocals are forbidden by the plan" });
  for (const [index, clip] of value.narration.entries()) {
    if (clip.startSec + clip.durationSec > value.target.durationSec) {
      context.addIssue({
        code: "custom",
        path: ["narration", index, "durationSec"],
        message: "narration clip extends beyond the target timeline",
      });
    }
  }
  const artifactIdentities = new Map<string, string>();
  const references = [
    ...value.scenes.flatMap((scene) => scene.sourceArtifact ? [scene.sourceArtifact] : []),
    ...value.scenes.flatMap((scene) => scene.video
      ? [scene.video.sourceImageArtifact].filter(
        (reference): reference is VerifiedProductionArtifactRef => Boolean(reference),
      )
      : []),
    ...value.narration.map((clip) => clip.artifact),
  ];
  for (const reference of references) {
    const identity = canonical(reference);
    const existing = artifactIdentities.get(reference.artifactId);
    if (existing && existing !== identity) {
      context.addIssue({ code: "custom", path: ["scenes"], message: `artifact ${reference.artifactId} has conflicting sealed identities` });
    }
    artifactIdentities.set(reference.artifactId, identity);
  }
  if (!value.scenes.length && !value.images.length && !value.soundtrack) {
    context.addIssue({ code: "custom", path: ["scenes"], message: "plan requires at least one generated or source media output" });
  }
  if (new Set(value.packTextChildren.map((child) => child.artifactId)).size !== value.packTextChildren.length) {
    context.addIssue({ code: "custom", path: ["packTextChildren"], message: "pack text children must have unique artifact identities" });
  }
  const requiredOperationIds = value.scenes.flatMap((scene) => {
    if (!scene.video) return [];
    const type = "generate_video";
    return [`${value.id}:${type}:${scene.id}`];
  });
  value.images.forEach((_image, index) => requiredOperationIds.push(`${value.id}:generate_image:image-${index + 1}`));
  if (value.soundtrack) requiredOperationIds.push(`${value.id}:generate_music`);
  requiredOperationIds.sort();
  const quotedOperationIds = Object.keys(value.operationCostsUsd).sort();
  const quotedMicros = Object.values(value.operationCostsUsd).reduce((total, cost) => total + BigInt(cost.replace(".", "")), BigInt(0));
  const estimatedMicros = BigInt(value.estimatedCostUsd.replace(".", ""));
  if (JSON.stringify(requiredOperationIds) !== JSON.stringify(quotedOperationIds) || quotedMicros !== estimatedMicros) {
    context.addIssue({ code: "custom", path: ["operationCostsUsd"], message: "operation cost quotes must exactly fund the paid operation graph" });
  }
});

export type GeneratedVideoSpec = z.infer<typeof generatedVideoSpecSchema>;
export type GeneratedMusicSpec = z.infer<typeof generatedMusicSpecSchema>;
export type GeneratedImageSpec = z.infer<typeof generatedImageSpecSchema>;
export type VideoProductionPlan = z.infer<typeof videoProductionPlanSchema>;

const operationTypes = ["extract_source_segment", "normalize_media", "generate_video", "generate_music", "generate_image", "generate_voice", "resolve_media", "build_composition", "render_composition", "mix_audio", "ffmpeg_finalize", "inspect_media", "evaluate_production", "repair_media", "inspect_delivery", "evaluate_delivery", "assemble_export", "assemble_media_pack", "publish_external"] as const;
export const productionOperationSchema = z.object({ id: z.string().min(1), jobId: z.string().min(1), type: z.enum(operationTypes), dependsOn: z.array(z.string().min(1)), payload: z.record(z.string(), z.unknown()), requestDigest: digest, estimatedCostUsd: usd.optional(), executionAuthority: z.enum(["production_mandate", "internal", "publication_approval"]) }).strict().superRefine((value, context) => {
  if (value.executionAuthority === "production_mandate" && !value.estimatedCostUsd) context.addIssue({ code: "custom", path: ["estimatedCostUsd"], message: "paid operation requires a sealed cost quote" });
  if (value.executionAuthority !== "production_mandate" && value.estimatedCostUsd) context.addIssue({ code: "custom", path: ["estimatedCostUsd"], message: "only paid operations carry cost quotes" });
});
export type ProductionOperation = z.infer<typeof productionOperationSchema>;

export const mediaOperationSchema = z.object({
  id: z.string().min(1), jobId: z.string().min(1), actionId: z.string().min(1), provider: z.enum(["nova_reel", "elevenlabs"]),
  state: z.enum(["prepared", "budget_reserved", "provider_submitted", "provider_pending", "provider_succeeded", "artifact_ingested", "independently_verified", "applied", "policy_filtered", "permanent_failure", "cancelled_before_submission", "unknown_after_submission"]),
  providerOperationId: z.string().min(1).optional(), attempt: z.number().int().nonnegative(), requestDigest: digest, estimatedCostUsd: usd,
  artifactId: z.string().min(1).optional(), artifactDigest: digest.optional(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type MediaOperation = z.infer<typeof mediaOperationSchema>;
export type MediaOperationState = MediaOperation["state"];

export const productionMandateSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  planDigest: digest,
  planRevision: z.number().int().positive(),
  jobId: z.string().min(1),
  workspaceId: z.string().min(1),
  brandId: z.string().min(1),
  operatorSubjectId: z.string().min(1),
  authenticationId: z.string().min(1),
  maximumCostUsd: usd,
  paidOperationDigests: z.array(digest).min(1),
  approvedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  mandateDigest: digest,
}).strict();
export type ProductionMandate = z.infer<typeof productionMandateSchema>;

const mediaTransitions: Record<MediaOperationState, readonly MediaOperationState[]> = {
  prepared: ["budget_reserved", "cancelled_before_submission"],
  budget_reserved: ["provider_submitted", "cancelled_before_submission", "permanent_failure"],
  provider_submitted: ["provider_pending", "provider_succeeded", "policy_filtered", "permanent_failure", "unknown_after_submission"],
  provider_pending: ["provider_pending", "provider_succeeded", "policy_filtered", "permanent_failure", "unknown_after_submission"],
  provider_succeeded: ["artifact_ingested", "permanent_failure"],
  artifact_ingested: ["independently_verified", "permanent_failure"],
  independently_verified: ["applied"],
  applied: [], policy_filtered: [], permanent_failure: [], cancelled_before_submission: [], unknown_after_submission: [],
};

export function transitionMediaOperation(operation: MediaOperation, state: MediaOperationState, updatedAt: string): MediaOperation {
  if (!mediaTransitions[operation.state].includes(state)) throw new Error(`invalid media operation transition: ${operation.state} -> ${state}`);
  if (["provider_submitted", "provider_pending", "provider_succeeded"].includes(state) && !operation.providerOperationId) throw new Error("provider operation id is required after submission");
  return mediaOperationSchema.parse({ ...operation, state, updatedAt });
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("unsupported canonical value");
}

const sha = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function generatedMediaRequestDigest(spec: GeneratedVideoSpec | GeneratedMusicSpec | GeneratedImageSpec): string { return sha(sealProviderRequest(spec)); }
export function productionPlanDigest(plan: VideoProductionPlan): string { return sha(videoProductionPlanSchema.parse(plan)); }

export function productionApprovalStillValid(
  approval: { planDigest: string; planRevision: number; expiresAt: string; paidOperationDigests?: string[] },
  plan: VideoProductionPlan,
  now = new Date(),
): boolean {
  const paidOperationDigests = compileProductionOperations(plan)
    .filter((operation) => operation.executionAuthority === "production_mandate")
    .map((operation) => operation.requestDigest);
  return approval.planRevision === plan.revision
    && approval.planDigest === productionPlanDigest(plan)
    && new Date(approval.expiresAt).getTime() > now.getTime()
    && (approval.paidOperationDigests === undefined || canonical(approval.paidOperationDigests) === canonical(paidOperationDigests));
}

export function createProductionMandate(
  plan: VideoProductionPlan,
  approval: { operatorSubjectId: string; authenticationId: string; approvedAt: string; expiresAt: string },
): ProductionMandate {
  const parsed = videoProductionPlanSchema.parse(plan);
  if (Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) throw new Error("production approval expiry must follow approval time");
  const paidOperationDigests = compileProductionOperations(parsed)
    .filter((operation) => operation.executionAuthority === "production_mandate")
    .map((operation) => operation.requestDigest);
  if (paidOperationDigests.length === 0) throw new Error("production mandate requires at least one paid operation");
  const unsigned = {
    id: `${parsed.id}:mandate:v${parsed.revision}`,
    planId: parsed.id,
    planDigest: productionPlanDigest(parsed),
    planRevision: parsed.revision,
    jobId: parsed.jobId,
    workspaceId: parsed.workspaceId,
    brandId: parsed.brandId,
    operatorSubjectId: approval.operatorSubjectId,
    authenticationId: approval.authenticationId,
    maximumCostUsd: parsed.maximumCostUsd,
    paidOperationDigests,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
  };
  return productionMandateSchema.parse({ ...unsigned, mandateDigest: sha(unsigned) });
}

export function assertProductionMandateAuthorizes(input: {
  mandate: ProductionMandate;
  plan: VideoProductionPlan;
  operation: ProductionOperation;
  activeMandateId: string | null;
  workspaceId: string;
  brandId: string;
  now?: Date;
}): ProductionOperation {
  const mandate = productionMandateSchema.parse(input.mandate);
  const plan = videoProductionPlanSchema.parse(input.plan);
  const operation = productionOperationSchema.parse(input.operation);
  if (input.activeMandateId !== mandate.id) throw new Error("production mandate is inactive");
  if (
    mandate.workspaceId !== input.workspaceId
    || mandate.brandId !== input.brandId
    || plan.workspaceId !== input.workspaceId
    || plan.brandId !== input.brandId
  ) throw new Error("production mandate tenant scope mismatch");
  if (mandate.jobId !== plan.jobId || operation.jobId !== plan.jobId) {
    throw new Error("production mandate job scope mismatch");
  }
  const { mandateDigest, ...unsigned } = mandate;
  if (sha(unsigned) !== mandateDigest) throw new Error("production mandate digest mismatch");
  const now = input.now ?? new Date();
  if (Date.parse(mandate.approvedAt) > now.getTime()) throw new Error("production mandate is not active yet");
  if (Date.parse(mandate.expiresAt) <= now.getTime()) throw new Error("production mandate expired");
  if (!productionApprovalStillValid(mandate, plan, now)) {
    throw new Error("production mandate does not authorize the current plan");
  }
  if (operation.executionAuthority !== "production_mandate") {
    throw new Error("production mandate authorizes only a paid operation");
  }
  const compiled = compileProductionOperations(plan).find((candidate) => candidate.id === operation.id);
  if (!compiled || canonical(compiled) !== canonical(operation)) {
    throw new Error("production operation is not in the sealed graph");
  }
  if (!mandate.paidOperationDigests.includes(operation.requestDigest)) {
    throw new Error("paid operation digest is not authorized");
  }
  return input.operation;
}

export function estimateGeneratedMediaCost(spec: GeneratedVideoSpec | GeneratedMusicSpec | GeneratedImageSpec, overrides: Record<string, string> = {}): string {
  const rate = Number(overrides[spec.modelCapability]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`pricing unavailable for ${spec.modelCapability}`);
  return (rate * ("mode" in spec ? spec.durationSec : "targetDurationSec" in spec ? spec.targetDurationSec : 1)).toFixed(6);
}

export function compileProductionOperations(plan: VideoProductionPlan): ProductionOperation[] {
  const compositionReferences = [
    ...plan.scenes.flatMap((scene) => scene.sourceArtifact ? [scene.sourceArtifact] : []),
    ...plan.narration.map((clip) => clip.artifact),
  ];
  const conditioningReferences = plan.scenes.flatMap((scene) => scene.video
    ? [scene.video.sourceImageArtifact].filter(
      (reference): reference is VerifiedProductionArtifactRef => Boolean(reference),
    )
    : []);
  const references = [...compositionReferences, ...conditioningReferences];
  const uniqueReferences = [...new Map(references.map((reference) => [reference.artifactId, reference])).values()];
  const resolved: ProductionOperation[] = uniqueReferences.map((reference) => ({
    id: `${plan.id}:resolve_media:${reference.artifactId}`,
    jobId: plan.jobId,
    type: "resolve_media",
    dependsOn: [],
    payload: reference,
    requestDigest: sha(reference),
    executionAuthority: "internal",
  }));
  const paid: ProductionOperation[] = [];
  for (const [index, image] of plan.images.entries()) {
    const id = `${plan.id}:generate_image:image-${index + 1}`;
    const payload = sealProviderRequest(image, plan.instructionContext);
    paid.push({ id, jobId: plan.jobId, type: "generate_image", dependsOn: [], payload, requestDigest: sha(payload), estimatedCostUsd: plan.operationCostsUsd[id], executionAuthority: "production_mandate" });
  }
  for (const scene of [...plan.scenes].sort((a, b) => a.order - b.order)) if (scene.video) {
    const type = "generate_video";
    const id = `${plan.id}:${type}:${scene.id}`;
    const payload = sealProviderRequest(scene.video, plan.instructionContext);
    const requestDigest = sha(payload);
    const conditioningIds = [scene.video.sourceImageArtifact]
      .filter((reference): reference is VerifiedProductionArtifactRef => Boolean(reference))
      .map((reference) => `${plan.id}:resolve_media:${reference.artifactId}`);
    paid.push({ id, jobId: plan.jobId, type, dependsOn: conditioningIds, payload, requestDigest, estimatedCostUsd: plan.operationCostsUsd[id], executionAuthority: "production_mandate" });
  }
  if (plan.soundtrack) {
    const id = `${plan.id}:generate_music`;
    const payload = sealProviderRequest(plan.soundtrack, plan.instructionContext);
    const requestDigest = sha(payload);
    paid.push({ id, jobId: plan.jobId, type: "generate_music", dependsOn: [], payload, requestDigest, estimatedCostUsd: plan.operationCostsUsd[id], executionAuthority: "production_mandate" });
  }
  // A request for provider media alone is a deliverable in its own right. Do
  // not force it through a video compositor: assemble an archive whose sealed
  // children are exactly the paid operation artifacts in this immutable graph.
  if (!plan.scenes.length) {
    const planDigest = productionPlanDigest(plan);
    const childOperationIds = paid.map((item) => item.id).sort();
    return [...resolved, ...paid, {
      id: `${plan.id}:assemble_export`, jobId: plan.jobId, type: "assemble_export", dependsOn: childOperationIds,
      payload: { planDigest, childOperationIds, packTextChildren: plan.packTextChildren },
      requestDigest: sha({ type: "assemble_export", planDigest, childOperationIds, packTextChildren: plan.packTextChildren }), executionAuthority: "internal",
    }];
  }
  const buildId = `${plan.id}:build_composition`;
  const chain: ProductionOperation[] = [
    { id: buildId, jobId: plan.jobId, type: "build_composition", dependsOn: [
      ...compositionReferences.map((reference) => `${plan.id}:resolve_media:${reference.artifactId}`),
      ...paid.map((item) => item.id),
    ], payload: { planDigest: productionPlanDigest(plan) }, requestDigest: sha({ planDigest: productionPlanDigest(plan) }), executionAuthority: "internal" },
  ];
  for (const type of ["render_composition", "mix_audio", "ffmpeg_finalize", "inspect_media", "evaluate_production"] as const) {
    const previous = chain.at(-1)!.id;
    const id = `${plan.id}:${type}`;
    chain.push({ id, jobId: plan.jobId, type, dependsOn: [previous], payload: { planDigest: productionPlanDigest(plan) }, requestDigest: sha({ type, planDigest: productionPlanDigest(plan) }), executionAuthority: "internal" });
  }
  const planDigest = productionPlanDigest(plan);
  const repairId = `${plan.id}:repair_media`;
  chain.push({
    id: repairId,
    jobId: plan.jobId,
    type: "repair_media",
    dependsOn: [`${plan.id}:ffmpeg_finalize`, `${plan.id}:evaluate_production`],
    payload: { planDigest },
    requestDigest: sha({ type: "repair_media", planDigest }),
    executionAuthority: "internal",
  });
  for (const type of ["inspect_delivery", "evaluate_delivery"] as const) {
    const previous = chain.at(-1)!.id;
    const id = `${plan.id}:${type}`;
    chain.push({
      id, jobId: plan.jobId, type, dependsOn: [previous], payload: { planDigest },
      requestDigest: sha({ type, planDigest }), executionAuthority: "internal",
    });
  }
  const exportType = "assemble_export" as const;
  chain.push({
    id: `${plan.id}:${exportType}`,
    jobId: plan.jobId,
    type: exportType,
    dependsOn: [repairId, `${plan.id}:evaluate_delivery`],
    payload: { planDigest },
    requestDigest: sha({ type: exportType, planDigest }),
    executionAuthority: "internal",
  });
  if (plan.images.length || plan.outputRequest) {
    const childOperationIds = paid.map((item) => item.id).sort();
    chain.push({
      id: `${plan.id}:assemble_media_pack`, jobId: plan.jobId, type: "assemble_media_pack", dependsOn: childOperationIds,
      payload: { planDigest, childOperationIds, packTextChildren: plan.packTextChildren }, requestDigest: sha({ type: "assemble_media_pack", planDigest, childOperationIds, packTextChildren: plan.packTextChildren }), executionAuthority: "internal",
    });
  }
  return [...resolved, ...paid, ...chain];
}
