import { getConfig, type Config } from "./config";
import type { MediaCapabilityConfiguration } from "./outputCapabilities";

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
