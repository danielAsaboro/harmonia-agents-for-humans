import { describe, expect, it } from "vitest";
import { OUTPUT_CAPABILITIES, availableOutputKinds, outputCapabilityStatus } from "@/lib/outputCapabilities";
import { OUTPUT_KINDS } from "@/lib/contracts";

describe("output capability registry", () => {
  it("covers every output kind and exposes only complete capabilities", () => {
    expect(Object.keys(OUTPUT_CAPABILITIES).sort()).toEqual([...OUTPUT_KINDS].sort());
    expect(availableOutputKinds({ hasTimedVideo: false, hasVerbatimQuote: true })).not.toContain("short_clip");
    expect(availableOutputKinds({ hasTimedVideo: true, hasVerbatimQuote: true })).toContain("short_clip");
    expect(OUTPUT_CAPABILITIES.linkedin_post.state).toBe("publish_when_connected");
    expect(OUTPUT_CAPABILITIES.blog_article.state).toBe("export_available");
  });
});

it("separates media support, provider configuration, and live verification", () => {
  for (const kind of ["social_image", "generated_video", "generated_music"] as const) {
    expect(OUTPUT_CAPABILITIES[kind].state).toBe("export_available");
    expect(OUTPUT_CAPABILITIES[kind].costClass).toBe("provider_metered");
    expect(outputCapabilityStatus(kind, { allowPaidProviders: false })).toEqual({
      supported: true,
      providerAvailability: "not_configured",
      liveVerification: "not_verified",
    });
    expect(outputCapabilityStatus(kind, {
      allowPaidProviders: true,
      generativeMediaEnabled: true,
      mediaOutputBucket: "media-output",
      elevenLabsApiKey: "test-key",
    })).toEqual({
      supported: true,
      providerAvailability: "configured",
      liveVerification: "not_verified",
    });
  }
  expect(Object.values(OUTPUT_CAPABILITIES).some(capability => String(capability.state) === "verified_export")).toBe(false);
});
