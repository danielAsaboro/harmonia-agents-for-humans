import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { videoProductionPlanSchema, type VideoProductionPlan } from "@/lib/mediaProduction";

const creativeDraftSchema = z.object({
  goal: z.string().min(1).max(500),
  audience: z.string().min(1).max(500),
  tone: z.array(z.string().min(1).max(100)).min(1).max(8),
  platform: z.string().min(1).max(100),
  aspectRatio: z.literal("16:9"),
  resolution: z.literal("720p"),
  frameRate: z.union([z.literal(24), z.literal(30)]),
  scenes: z.array(z.object({
    purpose: z.string().min(1).max(500),
    prompt: z.string().min(1).max(4000),
    durationSec: z.number().int().min(6).max(120).multipleOf(6),
  }).strict()).min(1).max(3),
  soundtrack: z.object({ include: z.boolean(), prompt: z.string().min(1).max(4000).optional() }).strict(),
}).strict().superRefine((value, context) => {
  if (value.soundtrack.include && !value.soundtrack.prompt) {
    context.addIssue({ code: "custom", path: ["soundtrack", "prompt"], message: "soundtrack prompt required" });
  }
});

export type ProductionCreativeDraft = z.infer<typeof creativeDraftSchema>;
type JobContext = { id: string; sourceAnalysis?: unknown; contentStrategy?: unknown; contentArtifacts?: unknown };
type DraftGenerator = (input: {
  request: string;
  job: JobContext;
  existing?: VideoProductionPlan;
}) => Promise<ProductionCreativeDraft>;
export interface ProductionPricingCatalog {
  version: string;
  novaReelUsdPerSecond: string;
  elevenLabsUsdPerSecond: string;
}

const priceSchema = z.string().regex(/^\d+\.\d{6}$/).refine((value) => BigInt(value.replace(".", "")) > BigInt(0));

function productionPricingCatalog(configured?: ProductionPricingCatalog): ProductionPricingCatalog {
  if (configured) {
    if (!priceSchema.safeParse(configured.novaReelUsdPerSecond).success) throw new Error("Nova Reel pricing is unavailable");
    if (!priceSchema.safeParse(configured.elevenLabsUsdPerSecond).success) throw new Error("ElevenLabs Music pricing is unavailable");
    if (!configured.version.trim()) throw new Error("media pricing version is unavailable");
    return configured;
  }
  const config = getConfig();
  if (!config.NOVA_REEL_COST_PER_SECOND_USD) throw new Error("Nova Reel pricing is unavailable");
  if (!config.ELEVENLABS_MUSIC_COST_PER_SECOND_USD) throw new Error("ElevenLabs Music pricing is unavailable");
  return {
    version: config.MODEL_PRICING_VERSION,
    novaReelUsdPerSecond: config.NOVA_REEL_COST_PER_SECOND_USD,
    elevenLabsUsdPerSecond: config.ELEVENLABS_MUSIC_COST_PER_SECOND_USD,
  };
}

const responseSchema = {
  type: "object",
  properties: {
    goal: { type: "string" }, audience: { type: "string" },
    tone: { type: "array", items: { type: "string" } }, platform: { type: "string" },
    aspectRatio: { type: "string", enum: ["16:9"] },
    resolution: { type: "string", enum: ["720p"] },
    frameRate: { type: "integer", enum: [24, 30] },
    scenes: { type: "array", maxItems: 3, items: { type: "object", properties: {
      purpose: { type: "string" }, prompt: { type: "string" }, durationSec: { type: "integer", minimum: 6, maximum: 120, multipleOf: 6 },
    }, required: ["purpose", "prompt", "durationSec"] } },
    soundtrack: { type: "object", properties: { include: { type: "boolean" }, prompt: { type: "string" } }, required: ["include"] },
  },
  required: ["goal", "audience", "tone", "platform", "aspectRatio", "resolution", "frameRate", "scenes", "soundtrack"],
} as const;

async function generateCreativeDraft(input: {
  request: string;
  job: JobContext;
  existing?: VideoProductionPlan;
}): Promise<ProductionCreativeDraft> {
  if (process.env.HARMONIA_ALLOW_PAID_AWS !== "true") throw new Error("paid AWS operations disabled");
  const groundedContext = JSON.stringify({
    sourceAnalysis: input.job.sourceAnalysis ?? null,
    contentStrategy: input.job.contentStrategy ?? null,
    contentArtifacts: input.job.contentArtifacts ?? null,
    existingPlan: input.existing ?? null,
  });
  const prompt = `Create a concise supported media-production creative draft from the operator request and supplied job evidence. Use only text-to-video shots. Each scene may be 6 seconds (single shot, prompt at most 512 characters) or a multiple of 6 between 12 and 120 seconds (automated multi-shot, prompt at most 4000 characters); use at most three scenes. Use 720p and 16:9. Include a soundtrack only when it materially serves the request; it must be instrumental. Do not invent source facts, likeness permissions, provider completion, costs, IDs, or approval. Operator request:\n${input.request}\nGrounded job evidence:\n${groundedContext}`;
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1", maxAttempts: 1 });
  const { reserveJobBudget, finalizeUsageRecord, resolveJobBudgetReservation } = await import("@/lib/repository");
  const { currentTraceId } = await import("@/lib/telemetry");
  const maximumCost = process.env.PRODUCTION_PLANNER_MAX_COST_USD;
  if (!maximumCost || !priceSchema.safeParse(maximumCost).success) throw new Error("PRODUCTION_PLANNER_MAX_COST_USD is required");
  const operationId = "production-plan:" + createHash("sha256").update(JSON.stringify({ jobId: input.job.id, request: input.request, revision: input.existing?.revision ?? 0 })).digest("hex");
  const model = process.env.PRODUCTION_PLANNER_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
  const reservation = await reserveJobBudget({ jobId: input.job.id, operationId, stage: "production", role: "production_planner", model, estimatedCostUsd: maximumCost, pricingVersion: "configured-aws-media-v1" });
  if (!reservation.reserved || reservation.duplicate) throw new Error("production planning requires a fresh admitted budget operation; reconcile existing outcomes before retry");
  try {
  const response = await client.send(new ConverseCommand({
    modelId: model,
    system: [{ text: "You are Harmonia's bounded media production planner. Return JSON only matching this schema: " + JSON.stringify(responseSchema) }],
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 3000, temperature: 0.2 },
  }));
  const text = response.output?.message?.content?.map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Bedrock returned no production plan draft");
  const draft = creativeDraftSchema.parse(JSON.parse(text));
  await finalizeUsageRecord({ id: "usage-" + operationId, jobId: input.job.id, operationId, stage: "production", role: "production_planner", model, inputUnits: response.usage?.inputTokens ?? 0, outputUnits: response.usage?.outputTokens ?? 0, unitType: "tokens", estimatedCostUsd: maximumCost, pricingVersion: "configured-aws-media-v1", traceId: currentTraceId(), createdAt: new Date().toISOString() });
  return draft;
  } catch (error) {
    await resolveJobBudgetReservation({ jobId: input.job.id, operationId, outcome: "uncertain", reason: "production planning failed after dispatch; reconcile before retry" });
    throw error;
  }
}

function usdFromMicros(micros: bigint): string {
  const value = micros.toString().padStart(7, "0");
  return `${value.slice(0, -6)}.${value.slice(-6)}`;
}

function stablePlanId(jobId: string): string {
  return `media-${createHash("sha256").update(jobId).digest("hex").slice(0, 24)}`;
}

export async function authorProductionPlan(input: {
  job: JobContext;
  workspaceId: string;
  brandId: string;
  request: string;
  existing?: VideoProductionPlan;
  generateDraft?: DraftGenerator;
  pricing?: ProductionPricingCatalog;
}): Promise<VideoProductionPlan> {
  const request = input.request.trim();
  if (!request) throw new Error("production plan request is required");
  const draft = creativeDraftSchema.parse(await (input.generateDraft ?? generateCreativeDraft)({
    request, job: input.job, ...(input.existing ? { existing: input.existing } : {}),
  }));
  const id = input.existing?.id ?? stablePlanId(input.job.id);
  const revision = (input.existing?.revision ?? 0) + 1;
  const pricing = productionPricingCatalog(input.pricing);
  let startSec = 0;
  const operationCostsUsd: Record<string, string> = {};
  const scenes = draft.scenes.map((scene, index) => {
    const sceneId = `scene-${index + 1}`;
    const cost = usdFromMicros(BigInt(scene.durationSec) * BigInt(pricing.novaReelUsdPerSecond.replace(".", "")));
    operationCostsUsd[`${id}:generate_video:${sceneId}`] = cost;
    const result = {
      id: sceneId, order: index + 1, startSec, durationSec: scene.durationSec,
      purpose: scene.purpose,
      video: {
        modelCapability: "nova-reel" as const, mode: "text_to_video" as const,
        prompt: scene.prompt, durationSec: scene.durationSec,
        aspectRatio: draft.aspectRatio, resolution: draft.resolution,
        outputCount: 1 as const,
      },
      overlays: [], captions: [], transitions: [],
    };
    startSec += scene.durationSec;
    return result;
  });
  const soundtrack = draft.soundtrack.include ? {
    modelCapability: "elevenlabs-music" as const,
    prompt: draft.soundtrack.prompt!, instrumental: true,
    targetDurationSec: 30, outputCount: 1 as const,
  } : undefined;
  if (soundtrack) operationCostsUsd[`${id}:generate_music`] = usdFromMicros(BigInt(30) * BigInt(pricing.elevenLabsUsdPerSecond.replace(".", "")));
  const estimatedMicros = Object.values(operationCostsUsd)
    .reduce((sum, cost) => sum + BigInt(cost.replace(".", "")), BigInt(0));
  const estimatedCostUsd = usdFromMicros(estimatedMicros);
  return videoProductionPlanSchema.parse({
    id, jobId: input.job.id, workspaceId: input.workspaceId, brandId: input.brandId, revision,
    goal: draft.goal, audience: draft.audience, tone: draft.tone,
    target: { platform: draft.platform, durationSec: startSec, aspectRatio: draft.aspectRatio, resolution: draft.resolution, frameRate: draft.frameRate, format: "mp4" },
    scenes, narration: [], ...(soundtrack ? { soundtrack } : {}),
    constraints: { allowLikeness: false, allowGeneratedVocals: false, requireLicensedSources: true },
    pricingVersion: pricing.version, operationCostsUsd,
    estimatedCostUsd, maximumCostUsd: estimatedCostUsd,
  });
}
