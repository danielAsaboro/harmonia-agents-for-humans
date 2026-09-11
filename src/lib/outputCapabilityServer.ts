import { getConfig, type Config } from "./config";
import { OUTPUT_CAPABILITIES, outputCapabilityStatus, type MediaCapabilityConfiguration, type OutputCapabilityStatus } from "./outputCapabilities";
import type { OutputKind } from "./types";

/** Keep private provider credentials on the server while exposing only facts. */
export function mediaCapabilityConfiguration(config: Config = getConfig()): MediaCapabilityConfiguration {
  return {
    allowPaidProviders: config.HARMONIA_ALLOW_PAID_AWS === "true",
    generativeMediaEnabled: config.GENERATIVE_MEDIA_ENABLED === "true",
    durableArtifactStorage: Boolean(config.S3_BUCKET),
    mediaOutputBucket: config.MEDIA_OUTPUT_BUCKET,
    elevenLabsApiKeyConfigured: Boolean(config.ELEVENLABS_API_KEY),
    novaCanvasPrice: config.NOVA_CANVAS_COST_PER_IMAGE_USD,
    novaReelPrice: config.NOVA_REEL_COST_PER_SECOND_USD,
    elevenLabsMusicPrice: config.ELEVENLABS_MUSIC_COST_PER_SECOND_USD,
    novaCanvasModel: config.NOVA_CANVAS_MODEL_ID,
    novaReelModel: config.NOVA_REEL_MODEL_ID,
    elevenLabsMusicModel: config.ELEVENLABS_MUSIC_MODEL_ID,
  };
}

/** Project complete server-side capability truth without exposing provider secrets. */
export function serverOutputCapabilityStatuses(
  config?: Config,
  liveVerifiedKinds: readonly OutputKind[] = [],
): Record<OutputKind, OutputCapabilityStatus> {
  // API routes can project capability facts even for locally retained jobs
  // whose read path does not otherwise require the complete runtime config.
  const mediaConfiguration = mediaCapabilityConfiguration(config ?? process.env as unknown as Config);
  const verified = new Set(liveVerifiedKinds);
  return Object.fromEntries((Object.keys(OUTPUT_CAPABILITIES) as OutputKind[]).map((kind) => {
    const status = outputCapabilityStatus(kind, mediaConfiguration);
    return [kind, verified.has(kind) && status.liveVerification === "not_verified"
      ? { ...status, liveVerification: "verified" as const }
      : status];
  })) as Record<OutputKind, OutputCapabilityStatus>;
}
