import { describe, expect, it } from "vitest";
import { surfacePlanSchema, uiContextSchema } from "../src/lib/a2ui/presentationContracts";

const context = {
  runId: "run-1",
  operatorRequest: "Compare the launch drafts.",
  intent: "list_drafts",
  job: {
    id: "job-1",
    stage: "awaiting_approval",
    status: "waiting_for_approval",
    title: "Outcome launch",
    sourceKind: "video",
  },
  drafts: [{ id: "draft-1", platform: "x", valid: true, momentId: "moment-1" }],
  moments: [{ id: "moment-1", title: "Outcome proof", startSec: 12, endSec: 24 }],
  sources: [{ id: "source-video", kind: "video", label: "Source video" }],
  assets: [],
  actions: [{ id: "action-1", type: "publish_x_post", pending: true }],
  receipts: [],
};

describe("A2UI presentation contracts", () => {
  it("accepts bounded reference summaries", () => {
    expect(uiContextSchema.parse(context).drafts[0].id).toBe("draft-1");
  });

  it("requires a durable run id", () => {
    const { runId: _runId, ...withoutRunId } = context;
    expect(uiContextSchema.safeParse(withoutRunId).success).toBe(false);
  });

  it("accepts known components with entity references", () => {
    const plan = surfacePlanSchema.parse({
      version: "harmonia.ui/v1",
      surfaces: [{
        slot: "canvas",
        revision: 1,
        rootId: "root",
        nodes: [{
          id: "root",
          component: "DraftComparison",
          refs: { jobId: "job-1", draftIds: ["draft-1"] },
          children: [],
        }],
      }],
    });

    expect(plan.surfaces[0].nodes[0].refs.draftIds).toEqual(["draft-1"]);
  });

  it("rejects model-authored approval risk", () => {
    const result = surfacePlanSchema.safeParse({
      version: "harmonia.ui/v1",
      surfaces: [{
        slot: "approval",
        revision: 1,
        rootId: "root",
        nodes: [{
          id: "root",
          component: "ApprovalReview",
          refs: { jobId: "job-1", actionIds: ["action-1"] },
          children: [],
          risk: "low",
        }],
      }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects dangling children", () => {
    const result = surfacePlanSchema.safeParse({
      version: "harmonia.ui/v1",
      surfaces: [{
        slot: "canvas",
        revision: 1,
        rootId: "root",
        nodes: [{
          id: "root",
          component: "CampaignBrief",
          refs: { jobId: "job-1" },
          children: ["missing"],
        }],
      }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects cyclic surface graphs", () => {
    const result = surfacePlanSchema.safeParse({
      version: "harmonia.ui/v1",
      surfaces: [{
        slot: "canvas",
        revision: 1,
        rootId: "root",
        nodes: [
          { id: "root", component: "CampaignBrief", refs: { jobId: "job-1" }, children: ["child"] },
          { id: "child", component: "JobProgress", refs: { jobId: "job-1" }, children: ["root"] },
        ],
      }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects nodes that are unreachable from the declared root", () => {
    const result = surfacePlanSchema.safeParse({
      version: "harmonia.ui/v1",
      surfaces: [{
        slot: "canvas",
        revision: 1,
        rootId: "root",
        nodes: [
          { id: "root", component: "CampaignBrief", refs: { jobId: "job-1" }, children: [] },
          { id: "orphan", component: "JobProgress", refs: { jobId: "job-1" }, children: [] },
        ],
      }],
    });

    expect(result.success).toBe(false);
  });
});
