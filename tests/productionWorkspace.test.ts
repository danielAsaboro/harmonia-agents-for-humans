import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobFull } from "@/components/jobTypes";
import { ProductionWorkspace } from "@/components/studio/ProductionWorkspace";
import { compileProductionOperations, productionPlanDigest, videoProductionPlanSchema } from "@/lib/mediaProduction";
import { sealOperatorInstructionContext } from "@/lib/operatorInstructions";

const instructionContext = sealOperatorInstructionContext({
  draftId: "b".repeat(64), revision: 3, originalOperatorBrief: "Create launch media.",
  answers: [
    { requestId: "initial-brief", message: "Create launch media." },
    { requestId: "answer-subject-colors", message: "Use a copper robot on midnight blue." },
    { requestId: "answer-outcome", message: "Drive waitlist signups.", resolvedField: "expectedOutcome" },
  ],
});

const plan = videoProductionPlanSchema.parse({
  id: "media-plan-1", jobId: "job-1", workspaceId: "workspace-1", brandId: "brand-1", revision: 1,
  goal: "Launch the autonomous content engine", audience: "startup founders", tone: ["clear"],
  target: { platform: "linkedin", durationSec: 6, aspectRatio: "16:9", resolution: "720p", frameRate: 30, format: "mp4" },
  scenes: [{
    id: "scene-1", order: 1, startSec: 0, durationSec: 6, purpose: "Show the product loop",
    video: { modelCapability: "nova-reel", mode: "text_to_video", prompt: "A precise product workflow", durationSec: 6, aspectRatio: "16:9", resolution: "720p", outputCount: 1 },
    overlays: [], captions: [], transitions: [],
  }],
  narration: [],
  constraints: { allowLikeness: false, allowGeneratedVocals: false, requireLicensedSources: true },
  pricingVersion: "2026-08-31", operationCostsUsd: { "media-plan-1:generate_video:scene-1": "0.320000" }, estimatedCostUsd: "0.320000", maximumCostUsd: "0.400000",
  instructionContext,
});
const digest = productionPlanDigest(plan);
const operations = compileProductionOperations(plan);
const job: JobFull = {
  id: "job-1", status: "active", stage: "publish", createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
  config: { sourceManifestId: "manifest-1", desiredOutputs: [], allowedOutputs: [], platforms: [] }, actions: [],
  productionPlan: {
    aggregate: { id: plan.id, jobId: jobId(), workspaceId: plan.workspaceId, brandId: plan.brandId, state: "sealed", currentRevision: 1, currentPlanDigest: digest, activeMandateId: null, currentMandateReservedCostUsd: "0.000000", internalRun: 0, createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" },
    revision: { revision: 1, plan, planDigest: digest, operations, proposedAt: "2026-08-31T00:00:00.000Z" },
    operations: operations.map((operation, index) => ({ id: operation.id, requestDigest: operation.requestDigest, type: operation.type, executionAuthority: operation.executionAuthority, dependsOn: operation.dependsOn, ...(operation.estimatedCostUsd ? { estimatedCostUsd: operation.estimatedCostUsd } : {}), state: index === 0 ? "waiting_provider" : "pending", attempt: index === 0 ? 1 : 0 })),
  },
};

function jobId() { return "job-1"; }

describe("production workspace", () => {
  it("shows the exact production approval boundary, cost, rationale, and graph state", () => {
    const html = renderToStaticMarkup(createElement(ProductionWorkspace, { job, onDecide: () => {}, onSeal: () => {} }));
    expect(html).toContain("Launch the autonomous content engine");
    expect(html).toContain("Approve production · $0.400000");
    expect(html).toContain("Production approval only.");
    expect(html).toContain("External publication remains separately gated.");
    expect(html).toContain("nova-reel");
    expect(html).toContain("waiting_provider");
    expect(html).toContain(operations[0].requestDigest);
    expect(html).toContain("Create launch media.");
    expect(html).toContain("Use a copper robot on midnight blue.");
    expect(html).toContain("answer-subject-colors");
    expect(html).toContain("answer-outcome");
    expect(html).not.toContain("Approve publication");
  });
});
