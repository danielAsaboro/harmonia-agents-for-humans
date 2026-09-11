import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutputIntentSelector } from "@/components/studio/OutputIntentSelector";
import { OUTPUT_CAPABILITIES } from "@/lib/outputCapabilities";

describe("OutputIntentSelector", () => {
  it("renders every registry capability with provider and verification truth", () => {
    const html = renderToStaticMarkup(createElement(OutputIntentSelector, { selected: [], onChange: () => undefined }));
    expect((html.match(/<button/g) ?? [])).toHaveLength(Object.keys(OUTPUT_CAPABILITIES).length);
    expect(html).toContain("Generated video");
    expect(html).toContain("Generated music");
    expect(html).toContain("Provider not configured");
    expect(html).toContain("Live verification pending");
    expect(html).toContain("LinkedIn post");
    expect(html).toContain("Publish when connected");
  });

  it("renders server-delivered configured status without reading browser configuration", () => {
    const html = renderToStaticMarkup(createElement(OutputIntentSelector, {
      selected: [], onChange: () => undefined,
      capabilityStatus: { generated_music: { supported: true, providerAvailability: "configured", liveVerification: "not_verified" } },
    }));
    expect(html).toContain("Generated music — Export available — Provider configured — Live verification pending");
    expect(html).not.toContain("Generated music — Export available — Provider not configured");
  });
});
