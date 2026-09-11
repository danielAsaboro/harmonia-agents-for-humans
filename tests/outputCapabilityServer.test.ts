import { describe, expect, it } from "vitest";

import { parseConfig } from "@/lib/config";
import { mediaCapabilityConfiguration, serverOutputCapabilityStatuses } from "@/lib/outputCapabilityServer";
import { outputCapabilityStatus } from "@/lib/outputCapabilities";
import { OUTPUT_CAPABILITIES } from "@/lib/outputCapabilities";

const environment = {
  INTERNAL_API_TOKEN: "internal", AGENT_SERVICE_URL: "http://127.0.0.1:8080", S3_BUCKET: "durable",
  HARMONIA_ALLOW_PAID_AWS: "true", GENERATIVE_MEDIA_ENABLED: "true", MEDIA_OUTPUT_BUCKET: "reel-output",
  ELEVENLABS_API_KEY: "private-key", NOVA_CANVAS_COST_PER_IMAGE_USD: "0.500000", NOVA_REEL_COST_PER_SECOND_USD: "0.080000", ELEVENLABS_MUSIC_COST_PER_SECOND_USD: "0.004000",
  NOVA_CANVAS_MODEL_ID: "amazon.nova-canvas-v1:0", NOVA_REEL_MODEL_ID: "amazon.nova-reel-v1:1", ELEVENLABS_MUSIC_MODEL_ID: "music_v1",
};

describe("server media capability configuration", () => {
  it("exposes configuration facts without leaking credentials and fails a changed model", () => {
    const status = mediaCapabilityConfiguration(parseConfig(environment));
    expect(status).not.toHaveProperty("elevenLabsApiKey");
    expect(outputCapabilityStatus("generated_music", status).providerAvailability).toBe("configured");
    expect(outputCapabilityStatus("generated_video", { ...status, novaReelModel: "amazon.nova-reel-v9:0" }).providerAvailability).toBe("not_configured");
  });

  it("projects every capability and preserves durable live verification separately", () => {
    const statuses = serverOutputCapabilityStatuses(parseConfig(environment), ["generated_music"]);
    expect(Object.keys(statuses)).toHaveLength(Object.keys(OUTPUT_CAPABILITIES).length);
    expect(statuses.social_image).toEqual({ supported: true, providerAvailability: "configured", liveVerification: "not_verified" });
    expect(statuses.generated_video).toEqual({ supported: true, providerAvailability: "configured", liveVerification: "not_verified" });
    expect(statuses.generated_music).toEqual({ supported: true, providerAvailability: "configured", liveVerification: "verified" });
  });
});
