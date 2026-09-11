import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ getJob: vi.fn(), appendEvent: vi.fn() }));
const store = vi.hoisted(() => ({ getProductionPlanWorkspaceForJob: vi.fn(), proposeProductionPlan: vi.fn(), sealProductionPlan: vi.fn() }));
vi.mock("@/lib/repository", () => repository);
vi.mock("@/lib/productionPlanStore", () => store);
vi.mock("@/lib/internalAuth", () => ({ internalTenantHandler: (handler: (request: Request) => Promise<Response>) => handler }));

import { POST } from "@/app/api/internal/output-media-production/route";
import { planRequestedMediaProduction } from "@/lib/outputMediaProduction";
import type { CampaignOutputPlan, Job } from "@/lib/types";

const outputPlan: CampaignOutputPlan = {
  id: "output-plan-1", digest: "a".repeat(64), desiredOutputs: ["social_image"], allowedOutputs: ["social_image"], outputs: [{ id: "image-1", outputType: "social_image", quantity: 1, destinations: ["content_pack"], evidenceRefs: [], costClass: "provider_metered", approvalClass: "strategy" }],
};
const job: Pick<Job, "id" | "workspaceId" | "brandId" | "config"> & { stage: "draft"; campaignOutputPlan: CampaignOutputPlan } = {
  id: "job-route-1", workspaceId: "workspace-1", brandId: "brand-1", stage: "draft", config: { operatorBrief: "Create a launch visual.", desiredOutputs: [], allowedOutputs: [], platforms: [] }, campaignOutputPlan: outputPlan,
};

describe("internal routed media proposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_TOKEN = "test-token"; process.env.AGENT_SERVICE_URL = "http://127.0.0.1:8080";
    process.env.MODEL_PRICING_VERSION = "test-pricing"; process.env.NOVA_CANVAS_COST_PER_IMAGE_USD = "0.500000";
    process.env.NOVA_REEL_COST_PER_SECOND_USD = "0.080000"; process.env.ELEVENLABS_MUSIC_COST_PER_SECOND_USD = "0.004000";
    repository.getJob.mockResolvedValue(job); repository.appendEvent.mockResolvedValue(undefined);
    store.getProductionPlanWorkspaceForJob.mockResolvedValue(null);
    store.proposeProductionPlan.mockResolvedValue({ id: "media-plan", state: "proposed" });
    store.sealProductionPlan.mockResolvedValue({ id: "media-plan", state: "sealed" });
  });
  it("creates and seals an exact proposal once, without dispatching a provider", async () => {
    const response = await POST(new Request("http://localhost/api/internal/output-media-production", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id }) }));
    expect(response.status).toBe(201);
    expect(store.proposeProductionPlan).toHaveBeenCalledOnce();
    expect(store.sealProductionPlan).toHaveBeenCalledOnce();
    const plan = store.proposeProductionPlan.mock.calls[0][0];
    expect(plan.outputRequest).toMatchObject({ outputPlanDigest: job.campaignOutputPlan.digest, outputIds: ["image-1"], contentRevision: 1 });
  });
  it("suppresses an unchanged routed proposal", async () => {
    const existingPlan = planRequestedMediaProduction({ job, outputPlan: job.campaignOutputPlan, pricing: { version: "test-pricing", canvasPerImage: "0.500000", reelPerSecond: "0.080000", musicPerSecond: "0.004000" } })!;
    store.getProductionPlanWorkspaceForJob.mockResolvedValue({
      aggregate: { state: "sealed" },
      revision: { plan: existingPlan },
    });
    const response = await POST(new Request("http://localhost/api/internal/output-media-production", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id }) }));
    expect((await response.json()).outcome).toBe("already_proposed");
    expect(store.proposeProductionPlan).not.toHaveBeenCalled();
  });
});
