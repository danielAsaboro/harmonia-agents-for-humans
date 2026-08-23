import { describe, expect, test, vi } from "vitest";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { harmoniaCatalog, parseHarmoniaA2uiOperation } from "../src/components/a2ui/HarmoniaCatalog";
import { generateResponseSurfaces } from "../src/lib/a2ui/responseSurface";
import type { JobFull } from "../src/components/jobTypes";

const job: JobFull = {
  id: "job-1", status: "waiting_for_approval", stage: "awaiting_approval", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:01:00.000Z",
  config: { brief: "Launch from outcomes", platforms: ["x"] }, transcriptSegments: [], moments: [], angles: [],
  drafts: [{ id: "draft-1", platform: "x", text: "This full draft must not reach the planner.", valid: true }],
  actions: [], assets: [],
};

describe("Harmonia A2UI surfaces", () => {
  test("passes bounded context to the planner and materializes its hydrated surface", async () => {
    const planner = vi.fn().mockResolvedValue({
      version: "harmonia.ui/v1",
      surfaces: [{ slot: "canvas", revision: 1, rootId: "drafts", nodes: [{ id: "drafts", component: "DraftComparison", refs: { jobId: "job-1", draftIds: ["draft-1"] }, children: [] }] }],
    });
    const surfaces = await generateResponseSurfaces({
      runId: "run-1",
      message: "Compare the drafts",
      response: { intent: "list_drafts", reply: "One draft is ready.", jobId: "job-1" },
      job,
      receipts: [],
      planner,
    });
    const processor = new MessageProcessor([harmoniaCatalog]);
    processor.processMessages(surfaces.canvas as never[]);

    const surface = processor.model.getSurface("studio-run-1-canvas-r1");
    expect(surface?.componentsModel.get("root")).toBeTruthy();
    expect(surface?.componentsModel.get("drafts")?.properties.drafts[0].text).toContain("full draft");
    expect(planner).toHaveBeenCalledWith(expect.objectContaining({ intent: "list_drafts" }));
    expect(JSON.stringify(planner.mock.calls[0][0])).not.toContain("full draft");
  });

  test("the trusted host rejects unknown components before processing", () => {
    expect(() => parseHarmoniaA2uiOperation({
      version: "v0.9",
      updateComponents: { surfaceId: "s1", components: [{ id: "root", component: "ArbitraryHtml", html: "<script />" }] },
    })).toThrow("not registered");
  });

  test("the trusted host accepts hydrated Harmonia workspace components", () => {
    const operations = [{
      version: "v0.9",
      createSurface: { surfaceId: "studio-run-1-approval-r1", catalogId: "https://harmonia.app/a2ui/catalogs/chat/v1" },
    }, {
      version: "v0.9",
      updateComponents: {
        surfaceId: "studio-run-1-approval-r1",
        components: [{ id: "root", component: "Column", children: ["approval"] }, {
          id: "approval",
          component: "ApprovalReview",
          jobId: "job-1",
          actionId: "publish-1",
          actionType: "publish_x_post",
          title: "Publish launch post",
          description: "Publish the approved post.",
          risk: "high",
          requiresApproval: true,
          approvalState: "pending",
          actionState: "planned",
          children: [],
          emphasis: "primary",
          agentFraming: false,
        }],
      },
    }];
    expect(() => operations.map(parseHarmoniaA2uiOperation)).not.toThrow();
    const processor = new MessageProcessor([harmoniaCatalog]);
    processor.processMessages(operations as never[]);
    expect(processor.model.getSurface("studio-run-1-approval-r1")?.componentsModel.get("approval")).toBeTruthy();
  });

  test("surfaces planner failures without a deterministic fallback", async () => {
    await expect(generateResponseSurfaces({
      runId: "run-2",
      message: "Show the job",
      response: { intent: "status", reply: "Ready.", jobId: "job-1" },
      job,
      receipts: [],
      planner: vi.fn().mockRejectedValue(new Error("Agent Engine unavailable")),
    })).rejects.toThrow("Agent Engine unavailable");
  });
});
