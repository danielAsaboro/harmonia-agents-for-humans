import { createHash } from "node:crypto";
import { getConfig } from "./config";
import { productionPlanDigest, videoProductionPlanSchema, type VideoProductionPlan } from "./mediaProduction";
import type { CampaignOutputPlan, Job } from "./types";
import type { ContentArtifact } from "./contentArtifacts/contracts";

type Pricing = { version: string; canvasPerImage: string; reelPerSecond: string; musicPerSecond: string };

const usd = (micros: bigint) => {
  const digits = micros.toString().padStart(7, "0");
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
};
const promptHash = (value: string) => createHash("sha256").update(value).digest("hex");
const stablePlanId = (jobId: string) => `media-${createHash("sha256").update(jobId).digest("hex").slice(0, 24)}`;

function configuredPricing(selected: Set<string>, input?: Pricing): Pricing {
  if (input) return input;
  const config = getConfig();
  if (selected.has("social_image") && !config.NOVA_CANVAS_COST_PER_IMAGE_USD) throw new Error("Nova Canvas pricing is required before proposing images");
  if (selected.has("generated_video") && !config.NOVA_REEL_COST_PER_SECOND_USD) throw new Error("Nova Reel pricing is required before proposing video");
  if (selected.has("generated_music") && !config.ELEVENLABS_MUSIC_COST_PER_SECOND_USD) throw new Error("ElevenLabs Music pricing is required before proposing music");
  return { version: config.MODEL_PRICING_VERSION, canvasPerImage: config.NOVA_CANVAS_COST_PER_IMAGE_USD ?? "0.000001", reelPerSecond: config.NOVA_REEL_COST_PER_SECOND_USD ?? "0.000001", musicPerSecond: config.ELEVENLABS_MUSIC_COST_PER_SECOND_USD ?? "0.000001" };
}

/**
 * Host-only conversion of routed output selections into sealed provider work.
 * The operator brief is copied verbatim into each request; no model is asked to
 * reinterpret it before the approval digest is created.
 */
export function planRequestedMediaProduction(input: {
  job: Pick<Job, "id" | "workspaceId" | "brandId" | "config">;
  outputPlan: CampaignOutputPlan;
  pricing?: Pricing;
  revision?: number;
}): VideoProductionPlan | null {
  const selected = input.outputPlan.outputs.filter((output) => ["social_image", "generated_video", "generated_music"].includes(output.outputType));
  const contentPack = input.outputPlan.outputs.find((output) => output.outputType === "content_pack");
  if (!selected.length) return null;
  const brief = input.job.config.operatorBrief;
  if (!brief) throw new Error("direct media production requires the operator brief that supplied the requested content");
  const instructionContext = input.job.config.instructionContext;
  if (instructionContext && instructionContext.resolvedInstructions !== brief) throw new Error("media production instructions differ from their intake provenance");
  if (instructionContext && input.job.config.originalOperatorBrief !== instructionContext.originalOperatorBrief) throw new Error("original operator brief differs from its intake provenance");
  const pricing = configuredPricing(new Set(selected.map((output) => output.outputType)), input.pricing);
  const id = stablePlanId(input.job.id);
  const revision = input.revision ?? 1;
  const images = selected.filter((output) => output.outputType === "social_image").flatMap((output) => Array.from({ length: output.quantity }, () => ({ modelCapability: "nova-canvas" as const, prompt: brief, width: 1024 as const, height: 1024 as const, outputCount: 1 as const })));
  const videoOutputs = selected.filter((output) => output.outputType === "generated_video");
  const scenes = videoOutputs.flatMap((output) => Array.from({ length: output.quantity }, (_unused, index) => ({
    id: `scene-${output.id}-${index + 1}`, order: index + 1, startSec: index * 6, durationSec: 6, purpose: "operator-requested generated video",
    video: { modelCapability: "nova-reel" as const, mode: "text_to_video" as const, prompt: brief, durationSec: 6, aspectRatio: "16:9" as const, resolution: "720p" as const, outputCount: 1 as const }, overlays: [], captions: [], transitions: [],
  })));
  const musicOutputs = selected.filter((output) => output.outputType === "generated_music");
  if (musicOutputs.some((output) => output.quantity !== 1)) throw new Error("generated music currently supports exactly one output per request");
  const wantsMusic = musicOutputs.length === 1;
  const soundtrack = wantsMusic ? { modelCapability: "elevenlabs-music" as const, prompt: brief, instrumental: true as const, targetDurationSec: 30, outputCount: 1 as const } : undefined;
  const operationCostsUsd: Record<string, string> = {};
  images.forEach((_image, index) => { operationCostsUsd[`${id}:generate_image:image-${index + 1}`] = pricing.canvasPerImage; });
  scenes.forEach((scene) => { operationCostsUsd[`${id}:generate_video:${scene.id}`] = usd(BigInt(6) * BigInt(pricing.reelPerSecond.replace(".", ""))); });
  if (soundtrack) operationCostsUsd[`${id}:generate_music`] = usd(BigInt(30) * BigInt(pricing.musicPerSecond.replace(".", "")));
  const estimate = usd(Object.values(operationCostsUsd).reduce((total, cost) => total + BigInt(cost.replace(".", "")), BigInt(0)));
  const destinations = [...new Set(selected.flatMap((output) => output.destinations))];
  return videoProductionPlanSchema.parse({
    id, jobId: input.job.id, workspaceId: input.job.workspaceId, brandId: input.job.brandId, revision,
    goal: brief, audience: "operator-selected audience", tone: ["operator-directed"],
    target: { platform: destinations[0] ?? "content_pack", durationSec: Math.max(6, scenes.length * 6), aspectRatio: "16:9", resolution: "720p", frameRate: 24, format: "mp4" },
    scenes, images, narration: [], ...(soundtrack ? { soundtrack } : {}),
    constraints: { allowLikeness: false, allowGeneratedVocals: false, requireLicensedSources: true },
    pricingVersion: pricing.version, operationCostsUsd, estimatedCostUsd: estimate, maximumCostUsd: estimate,
    outputRequest: { outputPlanId: input.outputPlan.id, outputPlanDigest: input.outputPlan.digest, outputIds: [...selected.map((output) => output.id), ...(contentPack ? [contentPack.id] : [])], contentRevision: revision, destinations, promptDigest: promptHash(brief) },
    ...(instructionContext ? { instructionContext } : {}),
  });
}

/** Bind text artifacts only after their host-sealed digests exist. This creates a
 * new plan revision, invalidating any prior approval before media execution. */
export function bindTextArtifactsToMediaPack(plan: VideoProductionPlan, artifacts: readonly Pick<ContentArtifact, "id" | "contentDigest" | "mimeType">[]): VideoProductionPlan {
  const parsed = videoProductionPlanSchema.parse(plan);
  if (!parsed.outputRequest?.outputIds.length) throw new Error("media pack requires a routed output request binding");
  const children = artifacts.map((artifact) => ({ artifactId: artifact.id, digest: artifact.contentDigest, mime: artifact.mimeType }));
  return videoProductionPlanSchema.parse({ ...parsed, revision: parsed.revision + 1, packTextChildren: children, outputRequest: { ...parsed.outputRequest, contentRevision: parsed.revision + 1 } });
}

export function mediaProposalSummary(plan: VideoProductionPlan) {
  const parsed = videoProductionPlanSchema.parse(plan);
  return { planId: parsed.id, revision: parsed.revision, planDigest: productionPlanDigest(parsed), maximumCostUsd: parsed.maximumCostUsd, outputRequest: parsed.outputRequest };
}
