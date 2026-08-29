import { createHash } from "node:crypto";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { videoProductionPlanSchema, type VideoProductionPlan } from "@/lib/mediaProduction";

const creativeDraftSchema = z.object({
  goal: z.string().min(1).max(500),
  audience: z.string().min(1).max(500),
  tone: z.array(z.string().min(1).max(100)).min(1).max(8),
  platform: z.string().min(1).max(100),
  aspectRatio: z.enum(["16:9", "9:16"]),
  resolution: z.enum(["720p", "1080p"]),
  frameRate: z.union([z.literal(24), z.literal(30)]),
  scenes: z.array(z.object({
    purpose: z.string().min(1).max(500),
    prompt: z.string().min(1).max(4000),
    durationSec: z.union([z.literal(4), z.literal(6), z.literal(8)]),
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

const responseSchema = {
  type: "object",
  properties: {
    goal: { type: "string" }, audience: { type: "string" },
    tone: { type: "array", items: { type: "string" } }, platform: { type: "string" },
    aspectRatio: { type: "string", enum: ["16:9", "9:16"] },
    resolution: { type: "string", enum: ["720p", "1080p"] },
    frameRate: { type: "integer", enum: [24, 30] },
    scenes: { type: "array", maxItems: 3, items: { type: "object", properties: {
      purpose: { type: "string" }, prompt: { type: "string" }, durationSec: { type: "integer", enum: [4, 6, 8] },
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured for production planning");
  const groundedContext = JSON.stringify({
    sourceAnalysis: input.job.sourceAnalysis ?? null,
    contentStrategy: input.job.contentStrategy ?? null,
    contentArtifacts: input.job.contentArtifacts ?? null,
    existingPlan: input.existing ?? null,
  });
  const prompt = `Create a concise supported media-production creative draft from the operator request and supplied job evidence. Use only text-to-video shots. Each shot must be 4, 6, or 8 seconds; use at most three. Use 720p or 1080p and 16:9 or 9:16. Include a soundtrack only when it materially serves the request; it must be instrumental. Do not invent source facts, likeness permissions, provider completion, costs, IDs, or approval. Operator request:\n${input.request}\nGrounded job evidence:\n${groundedContext}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${getConfig().MODEL_ID}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "You are Harmonia's bounded media production planner. Return JSON only and obey the supplied capability envelope." }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Gemini production planning failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no production plan draft");
  return creativeDraftSchema.parse(JSON.parse(text));
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
}): Promise<VideoProductionPlan> {
  const request = input.request.trim();
  if (!request) throw new Error("production plan request is required");
  const draft = creativeDraftSchema.parse(await (input.generateDraft ?? generateCreativeDraft)({
    request, job: input.job, ...(input.existing ? { existing: input.existing } : {}),
  }));
  const id = input.existing?.id ?? stablePlanId(input.job.id);
  const revision = (input.existing?.revision ?? 0) + 1;
  let startSec = 0;
  const operationCostsUsd: Record<string, string> = {};
  const scenes = draft.scenes.map((scene, index) => {
    const sceneId = `scene-${index + 1}`;
    const cost = usdFromMicros(BigInt(scene.durationSec) * BigInt(80_000));
    operationCostsUsd[`${id}:generate_video:${sceneId}`] = cost;
    const result = {
      id: sceneId, order: index + 1, startSec, durationSec: scene.durationSec,
      purpose: scene.purpose, sourceArtifactIds: [],
      video: {
        modelCapability: "veo-3.1-fast" as const, mode: "text_to_video" as const,
        prompt: scene.prompt, durationSec: scene.durationSec,
        aspectRatio: draft.aspectRatio, resolution: draft.resolution,
        generateAudio: false, enhancePrompt: true, outputCount: 1 as const,
      },
      overlays: [], captions: [], transitions: [],
    };
    startSec += scene.durationSec;
    return result;
  });
  const soundtrack = draft.soundtrack.include ? {
    modelCapability: "lyria-2" as const,
    prompt: draft.soundtrack.prompt!, instrumental: true, lyricsMode: "none" as const,
    language: "en", targetDurationSec: startSec, outputCount: 1 as const,
  } : undefined;
  if (soundtrack) operationCostsUsd[`${id}:generate_music`] = "0.060000";
  const estimatedMicros = Object.values(operationCostsUsd)
    .reduce((sum, cost) => sum + BigInt(cost.replace(".", "")), BigInt(0));
  const estimatedCostUsd = usdFromMicros(estimatedMicros);
  return videoProductionPlanSchema.parse({
    id, jobId: input.job.id, workspaceId: input.workspaceId, brandId: input.brandId, revision,
    goal: draft.goal, audience: draft.audience, tone: draft.tone,
    target: { platform: draft.platform, durationSec: startSec, aspectRatio: draft.aspectRatio, resolution: draft.resolution, frameRate: draft.frameRate, format: "mp4" },
    scenes, ...(soundtrack ? { soundtrack } : {}),
    constraints: { allowLikeness: false, allowGeneratedVocals: false, requireLicensedSources: true },
    pricingVersion: "google-media-2026-08-31", operationCostsUsd,
    estimatedCostUsd, maximumCostUsd: estimatedCostUsd,
  });
}
