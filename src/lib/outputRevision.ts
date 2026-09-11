import { z } from "zod";
import { outputKindSchema } from "./contracts";
import { outputCapabilityStatus } from "./outputCapabilities";

export const outputRevisionSchema = z.object({
  expectedControlEpoch: z.number().int().nonnegative(),
  desiredOutputs: z.array(outputKindSchema).min(1).max(16),
}).strict();

export function planOutputRevision(job: {
  status: string; stage: string; controlEpoch?: number;
  actions?: unknown[]; config: Record<string, unknown>;
}, expectedEpoch: number, requested: unknown) {
  const desiredOutputs = z.array(outputKindSchema).min(1).max(16).parse(requested);
  if ((job.controlEpoch ?? 0) !== expectedEpoch) throw new Error("stale output revision epoch");
  if (job.status !== "failed" || !["collect_sources", "extract_sources", "understand"].includes(job.stage) || job.actions?.length) {
    throw new Error("output correction requires a failed pre-strategy job without prepared effects");
  }
  if (new Set(desiredOutputs).size !== desiredOutputs.length) throw new Error("duplicate outputs");
  if (desiredOutputs.some((kind) => !outputCapabilityStatus(kind).supported)) throw new Error("unsupported output");
  const children = new Set(["x_post", "x_thread", "linkedin_post", "blog_article", "newsletter", "caption", "carousel_spec", "social_image", "quote_card", "diagram", "short_clip", "reel", "generated_video", "generated_music"]);
  if (desiredOutputs.includes("content_pack") && !desiredOutputs.some((kind) => children.has(kind))) {
    throw new Error("content pack requires at least one supported child content output");
  }
  return {
    controlEpoch: expectedEpoch + 1,
    config: { ...job.config, desiredOutputs, allowedOutputs: desiredOutputs },
  };
}
