import { describe, expect, it } from "vitest";
import { createOrReviseProductionPlanFromChat, productionModelExplanation, productionStatusReply } from "@/lib/chatHandler";
import { compileProductionOperations, productionPlanDigest, videoProductionPlanSchema } from "@/lib/mediaProduction";
import type { ProductionPlanWorkspaceView } from "@/lib/productionPlanStore";

const plan = videoProductionPlanSchema.parse({
  id: "plan-chat", jobId: "job-chat", workspaceId: "workspace-1", brandId: "brand-1", revision: 1,
  goal: "Explain the launch", audience: "founders", tone: ["clear"],
  target: { platform: "linkedin", durationSec: 4, aspectRatio: "9:16", resolution: "1080p", frameRate: 30, format: "mp4" },
  scenes: [{
    id: "scene-1", order: 1, startSec: 0, durationSec: 4, purpose: "Show the workflow", sourceArtifactIds: [],
    video: { modelCapability: "veo-3.1-fast", mode: "text_to_video", prompt: "A measured product workflow", durationSec: 4, aspectRatio: "9:16", resolution: "1080p", generateAudio: false, enhancePrompt: true, outputCount: 1 },
    overlays: [], captions: [], transitions: [],
  }],
  constraints: { allowLikeness: false, allowGeneratedVocals: false, requireLicensedSources: true },
  pricingVersion: "2026-08-31", operationCostsUsd: { "plan-chat:generate_video:scene-1": "0.320000" }, estimatedCostUsd: "0.320000", maximumCostUsd: "0.400000",
});
const digest = productionPlanDigest(plan);
const compiled = compileProductionOperations(plan);
const workspace: ProductionPlanWorkspaceView = {
  aggregate: { id: plan.id, jobId: plan.jobId, workspaceId: plan.workspaceId, brandId: plan.brandId, state: "approved", currentRevision: 1, currentPlanDigest: digest, activeMandateId: "mandate-1", currentMandateReservedCostUsd: "0.320000", createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" },
  revision: { revision: 1, plan, planDigest: digest, operations: compiled, proposedAt: "2026-08-31T00:00:00.000Z" },
  operations: compiled.map((operation, index) => ({ id: operation.id, type: operation.type, executionAuthority: operation.executionAuthority, dependsOn: operation.dependsOn, ...(operation.estimatedCostUsd ? { estimatedCostUsd: operation.estimatedCostUsd } : {}), state: index === 0 ? "waiting_provider" : "pending", attempt: index === 0 ? 1 : 0, ...(index === 0 ? { provider: "veo" as const } : {}) })),
};

describe("production chat projections", () => {
  it("reports only persisted operation state and preserves the publication boundary", () => {
    const reply = productionStatusReply(workspace);
    expect(reply).toContain("1 waiting_provider");
    expect(reply).toContain("generate_video via veo");
    expect(reply).toContain("does not authorize publication");
  });

  it("explains the exact sealed controls and revision consequence", () => {
    const reply = productionModelExplanation(workspace);
    expect(reply).toContain("veo-3.1-fast");
    expect(reply).toContain("text_to_video at 1080p, 4s, 9:16");
    expect(reply).toContain("No generated soundtrack");
    expect(reply).toContain("invalidates the current mandate");
  });

  it("authors and persists a revision from the immutable current plan", async () => {
    const getJob = async () => ({ id: plan.jobId, sourceAnalysis: { summary: "Grounded source" } });
    const getWorkspace = async () => workspace;
    const author = async (input: { existing?: typeof plan }) => ({ ...plan, revision: input.existing!.revision + 1 });
    const propose = async (next: typeof plan) => ({ ...workspace.aggregate, state: "proposed" as const, currentRevision: next.revision });
    const result = await createOrReviseProductionPlanFromChat({
      jobId: plan.jobId, request: "Remove the soundtrack", revise: true,
    }, { getJob: getJob as never, getWorkspace, author: author as never, propose: propose as never, tenant: { workspaceId: plan.workspaceId, brandId: plan.brandId } });
    expect(result.plan.revision).toBe(2);
    expect(result.aggregate).toMatchObject({ state: "proposed", currentRevision: 2 });
  });
});
