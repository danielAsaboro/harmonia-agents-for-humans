import type { OutputKind } from "./types";

export interface OutputCapability {
  state: "export_available" | "publish_when_connected" | "unavailable";
  requiresTimedVideo: boolean;
  requiresVerbatimQuote: boolean;
  approvalClass: "strategy" | "effect";
  costClass: "local" | "provider_metered";
  publisher?: "x" | "linkedin";
  mediaProvider?: "nova_canvas" | "nova_reel" | "elevenlabs";
}

const exportable = { state: "export_available", requiresTimedVideo: false, requiresVerbatimQuote: false, approvalClass: "strategy", costClass: "local" } as const;
export const OUTPUT_CAPABILITIES: Record<OutputKind, OutputCapability> = {
  x_post: { ...exportable, state: "publish_when_connected", approvalClass: "effect", publisher: "x" },
  x_thread: { ...exportable, state: "publish_when_connected", approvalClass: "effect", publisher: "x" },
  linkedin_post: { ...exportable, state: "publish_when_connected", approvalClass: "effect", publisher: "linkedin" },
  blog_article: exportable, newsletter: exportable, caption: exportable, carousel_spec: exportable,
  social_image: { ...exportable, costClass: "provider_metered", mediaProvider: "nova_canvas" },
  quote_card: { ...exportable, requiresVerbatimQuote: true }, diagram: exportable,
  short_clip: { ...exportable, requiresTimedVideo: true, approvalClass: "effect" }, reel: { ...exportable, requiresTimedVideo: true, approvalClass: "effect" },
  generated_video: { ...exportable, approvalClass: "effect", costClass: "provider_metered", mediaProvider: "nova_reel" },
  generated_music: { ...exportable, approvalClass: "effect", costClass: "provider_metered", mediaProvider: "elevenlabs" },
  editorial_calendar: exportable, content_pack: exportable,
};

export interface OutputCapabilityStatus {
  supported: boolean;
  providerAvailability: "not_required" | "configured" | "not_configured";
  liveVerification: "not_applicable" | "not_verified" | "verified";
}

/** Configuration status never claims that a provider was invoked or verified. */
export function outputCapabilityStatus(
  kind: OutputKind,
  options: {
    allowPaidProviders?: boolean;
    generativeMediaEnabled?: boolean;
    mediaOutputBucket?: string;
    elevenLabsApiKey?: string;
  } = {},
): OutputCapabilityStatus {
  const capability = OUTPUT_CAPABILITIES[kind];
  if (capability.state === "unavailable") {
    return { supported: false, providerAvailability: "not_required", liveVerification: "not_applicable" };
  }
  if (!capability.mediaProvider) {
    return { supported: true, providerAvailability: "not_required", liveVerification: "not_applicable" };
  }
  const paid = options.allowPaidProviders ?? process.env.HARMONIA_ALLOW_PAID_AWS === "true";
  const enabled = options.generativeMediaEnabled ?? process.env.GENERATIVE_MEDIA_ENABLED === "true";
  const configured = paid
    && enabled
    && (!(["nova_reel", "nova_canvas"] as readonly string[]).includes(capability.mediaProvider)
      || Boolean(options.mediaOutputBucket ?? process.env.MEDIA_OUTPUT_BUCKET ?? process.env.S3_BUCKET))
    && (capability.mediaProvider !== "elevenlabs"
      || Boolean(options.elevenLabsApiKey ?? process.env.ELEVENLABS_API_KEY));
  return {
    supported: true,
    providerAvailability: configured ? "configured" : "not_configured",
    liveVerification: "not_verified",
  };
}

export function availableOutputKinds(context: { hasTimedVideo: boolean; hasVerbatimQuote: boolean }): OutputKind[] {
  return (Object.entries(OUTPUT_CAPABILITIES) as Array<[OutputKind, OutputCapability]>).filter(([, capability]) => capability.state !== "unavailable" && (!capability.requiresTimedVideo || context.hasTimedVideo) && (!capability.requiresVerbatimQuote || context.hasVerbatimQuote)).map(([kind]) => kind);
}
