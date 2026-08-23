import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioConsoleView } from "../src/components/ChatConsole";

describe("studio console integration", () => {
  it("renders a hydrated conversation and cross-media approval working set", () => {
    const job = {
      id: "job-1", status: "waiting_for_approval", stage: "awaiting_approval" as const, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
      config: { platforms: ["x"], brief: "Make the launch matter" }, transcriptSegments: [], moments: [], angles: [],
      drafts: [{ id: "draft-1", platform: "x", text: "The launch is here.", valid: true }],
      actions: [{ id: "publish-1", jobId: "job-1", type: "publish_x_post" as const, title: "Publish launch", description: "", risk: "high" as const, requiresApproval: true, approvalState: "pending" as const, payload: { text: "The launch is here." }, state: "planned" as const }],
      assets: [{ actionId: "image-1", mime: "image/png", sizeBytes: 1200, digest: "d" }],
    };
    const html = renderToStaticMarkup(createElement(StudioConsoleView, {
      messages: [{ role: "user", text: "Create launch content" }, { role: "assistant", text: "The working set is ready", data: { intent: "create_job", reply: "", jobId: "job-1" } }],
      loaded: true, detail: { job, events: [], receipts: [] }, liveRun: null, input: "", onInputChange: () => {}, attachments: [], onAttachmentsChange: () => {}, busy: false, onSend: () => {}, onOpenJob: () => {}, selectedArtifactId: null, onSelectedArtifactChange: () => {}, mobilePane: "conversation", onMobilePaneChange: () => {}, onDecide: () => {}, onOperationDecision: () => {},
    }));
    expect(html).toContain("Make the idea travel");
    expect(html).toContain("--studio-conversation:2fr");
    expect(html).toContain("Written");
    expect(html).toContain("publish-1");
  });
});
