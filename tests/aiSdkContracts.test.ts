import { describe, expect, test } from "vitest";
import {
  AI_SDK_UI_PROTOCOL,
  parseCatalogComponent,
  parseChatStreamEvent,
} from "../src/lib/ai-sdk/contracts";

describe("Harmonia AI SDK contracts", () => {
  test("accepts a sequenced safe activity event", () => {
    expect(
      parseChatStreamEvent({
        type: "activity",
        runId: "run-1",
        sequence: 2,
        activity: {
          id: "step-1",
          label: "Analyst reviewed the uploaded video",
          status: "complete",
        },
      }),
    ).toMatchObject({ type: "activity", sequence: 2 });
  });

  test("rejects raw hidden reasoning fields", () => {
    expect(() =>
      parseChatStreamEvent({
        type: "activity",
        runId: "run-1",
        sequence: 2,
        activity: {
          id: "step-1",
          label: "Analyzing",
          status: "active",
          rawReasoning: "private provider thought tokens",
        },
      }),
    ).toThrow();
  });

  test("rejects unsafe citation URLs", () => {
    expect(() =>
      parseCatalogComponent({
        component: "InlineCitation",
        id: "citation-1",
        title: "unsafe",
        url: "javascript:alert(1)",
      }),
    ).toThrow();
  });

  test("requires server operation references for confirmations", () => {
    expect(() =>
      parseCatalogComponent({
        component: "Confirmation",
        id: "confirm-1",
        title: "Run a tool",
        operationId: "",
        risk: "material",
        state: "pending",
      }),
    ).toThrow();
  });

  test("rejects component names outside the registered catalog", () => {
    expect(() =>
      parseCatalogComponent({ component: "ArbitraryHtml", id: "x", html: "<script />" }),
    ).toThrow();
    expect(AI_SDK_UI_PROTOCOL).toContain("harmonia");
  });

  test("accepts only bounded hydrated presentation tokens", () => {
    const campaignBrief = {
      component: "CampaignBrief",
      id: "brief-1",
      jobId: "job-1",
      title: "Campaign direction",
      brief: "Lead with measurable outcomes.",
      sourceKind: "text",
      platforms: ["x"],
      angles: [],
      children: [],
      emphasis: "primary",
      agentFraming: false,
      tone: "ink",
      role: "hero",
      density: "airy",
      motion: "reveal",
      surfaceRhythm: "editorial",
      surfaceComposition: "mosaic",
      surfaceEnergy: "active",
      revision: 2,
    };

    expect(() => parseCatalogComponent(campaignBrief)).not.toThrow();
    expect(() => parseCatalogComponent({ ...campaignBrief, tone: "hotpink" })).toThrow();
    expect(() => parseCatalogComponent({ ...campaignBrief, css: "position:fixed" })).toThrow();
  });
});
