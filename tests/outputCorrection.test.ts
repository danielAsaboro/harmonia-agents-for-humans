import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { JobFull } from "@/components/jobTypes";
import { OutputCorrection } from "@/components/studio/OutputCorrection";
import type { OutputCapabilityStatus } from "@/lib/outputCapabilities";
import type { OutputKind } from "@/lib/types";

const local: OutputCapabilityStatus = {
  supported: true,
  providerAvailability: "not_required",
  liveVerification: "not_applicable",
};

const capabilityStatuses: Record<OutputKind, OutputCapabilityStatus> = {
  x_post: local,
  x_thread: local,
  linkedin_post: local,
  blog_article: local,
  newsletter: local,
  caption: local,
  carousel_spec: local,
  social_image: { supported: true, providerAvailability: "configured", liveVerification: "not_verified" },
  quote_card: local,
  diagram: local,
  short_clip: local,
  reel: local,
  generated_video: { supported: false, providerAvailability: "not_configured", liveVerification: "not_applicable" },
  generated_music: { supported: true, providerAvailability: "configured", liveVerification: "verified" },
  editorial_calendar: local,
  content_pack: local,
};

describe("OutputCorrection", () => {
  it("renders the complete server capability truth when the failed job has no output plan", () => {
    const job = {
      id: "failed-output-job",
      status: "failed",
      stage: "understand",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
      config: {
        desiredOutputs: ["x_post"],
        allowedOutputs: ["x_post"],
        platforms: ["x"],
      },
      controlEpoch: 1,
      actions: [],
      outputCapabilityStatuses: capabilityStatuses,
      failure: {
        stage: "understand",
        category: "validation",
        code: "output_requires_correction",
        publicMessage: "Correct the selected outputs.",
        retryable: false,
        operationId: "job:failed-output-job:stage:understand:generation:1",
        traceId: "a".repeat(32),
        attempt: 1,
        maxAttempts: 3,
        details: {},
        at: "2026-09-11T00:00:00.000Z",
      },
    } as JobFull & { outputCapabilityStatuses: typeof capabilityStatuses };

    expect(job.campaignOutputPlan).toBeUndefined();
    const html = renderToStaticMarkup(createElement(OutputCorrection, { job }));
    expect(html).toContain("Social image — Export available — Provider configured — Live verification pending");
    expect(html).toContain("Generated video — Unavailable — Provider not configured");
    expect(html).toContain("Generated music — Export available — Provider configured — Live verified");
  });
});
