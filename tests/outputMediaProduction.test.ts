import { describe, expect, it } from "vitest";
import { compileProductionOperations, productionPlanDigest } from "@/lib/mediaProduction";
import { bindTextArtifactsToMediaPack, planRequestedMediaProduction } from "@/lib/outputMediaProduction";
import type { CampaignOutputPlan, Job } from "@/lib/types";
import { sealOperatorInstructionContext } from "@/lib/operatorInstructions";

const digest = "a".repeat(64);
const instructionContext = sealOperatorInstructionContext({
  draftId: "b".repeat(64), revision: 3, originalOperatorBrief: "Create launch media.",
  answers: [
    { requestId: "initial-brief", message: "Create launch media." },
    { requestId: "answer-subject-colors", message: "Feature a copper robot on midnight blue." },
    { requestId: "answer-outcome", message: "Drive waitlist signups.", resolvedField: "expectedOutcome" },
  ],
});
const job: Pick<Job, "id" | "workspaceId" | "brandId" | "config"> = {
  id: "job-media-1", workspaceId: "workspace-1", brandId: "brand-1",
  config: {
    operatorBrief: instructionContext.resolvedInstructions,
    originalOperatorBrief: instructionContext.originalOperatorBrief,
    instructionContext,
    desiredOutputs: [], allowedOutputs: [], platforms: [],
  },
};
const outputPlan = {
  id: "output-plan-1", digest, desiredOutputs: ["social_image", "generated_video", "generated_music"], allowedOutputs: ["social_image", "generated_video", "generated_music"],
  outputs: [
    { id: "image-1", outputType: "social_image", quantity: 1, destinations: ["content_pack"], evidenceRefs: [], costClass: "provider_metered", approvalClass: "strategy" },
    { id: "video-1", outputType: "generated_video", quantity: 1, destinations: ["content_pack"], evidenceRefs: [], costClass: "provider_metered", approvalClass: "effect" },
    { id: "music-1", outputType: "generated_music", quantity: 1, destinations: ["content_pack"], evidenceRefs: [], costClass: "provider_metered", approvalClass: "effect" },
  ],
} satisfies CampaignOutputPlan;

describe("routed media production proposal", () => {
  it("preserves every requested output in one exact, digest-bound proposal", () => {
    const plan = planRequestedMediaProduction({
      job, outputPlan,
      pricing: { version: "test-pricing", canvasPerImage: "0.500000", reelPerSecond: "0.080000", musicPerSecond: "0.004000" },
    });
    expect(plan).not.toBeNull();
    const operations = compileProductionOperations(plan!);
    expect(operations.filter((operation) => operation.executionAuthority === "production_mandate").map((operation) => operation.type).sort()).toEqual(["generate_image", "generate_music", "generate_video"]);
    const paidIds = operations.filter((operation) => operation.executionAuthority === "production_mandate").map((operation) => operation.id).sort();
    expect(operations.find((operation) => operation.type === "assemble_media_pack")).toMatchObject({ dependsOn: paidIds });
    expect(plan!.outputRequest).toMatchObject({ outputPlanId: "output-plan-1", outputPlanDigest: digest, outputIds: ["image-1", "video-1", "music-1"], contentRevision: 1, destinations: ["content_pack"] });
    expect(plan!.maximumCostUsd).toBe("1.100000");
    expect(plan!.instructionContext).toEqual(instructionContext);
    expect(plan!.goal).toBe(instructionContext.resolvedInstructions);
    for (const operation of operations.filter((operation) => operation.executionAuthority === "production_mandate")) {
      expect(operation.payload).toMatchObject({ instructionContext });
      expect(operation.payload.request).toMatchObject({ prompt: instructionContext.resolvedInstructions });
    }
    expect(productionPlanDigest(plan!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds clarification provenance into the approval digest even when creative text is unchanged", () => {
    const plan = planRequestedMediaProduction({
      job, outputPlan,
      pricing: { version: "test-pricing", canvasPerImage: "0.500000", reelPerSecond: "0.080000", musicPerSecond: "0.004000" },
    })!;
    const changedProvenance = sealOperatorInstructionContext({
      draftId: instructionContext.intakeDraftId, revision: instructionContext.intakeRevision,
      originalOperatorBrief: instructionContext.originalOperatorBrief,
      answers: [
        { requestId: "initial-brief", message: instructionContext.originalOperatorBrief },
        { requestId: "different-subject-turn", message: "Feature a copper robot on midnight blue." },
        { requestId: "different-outcome-turn", message: "Drive waitlist signups.", resolvedField: "expectedOutcome" },
      ],
    });
    expect(productionPlanDigest({ ...plan, instructionContext: changedProvenance })).not.toBe(productionPlanDigest(plan));
  });

  it("does not make a production plan where no provider media was selected", () => {
    expect(planRequestedMediaProduction({ job, outputPlan: { ...outputPlan, outputs: [] }, pricing: { version: "test", canvasPerImage: "0.500000", reelPerSecond: "0.080000", musicPerSecond: "0.004000" } })).toBeNull();
  });

  it("invalidates the original proposal when a mixed content pack gains sealed text children", () => {
    const mixed: CampaignOutputPlan = { ...outputPlan, desiredOutputs: [...outputPlan.desiredOutputs, "content_pack"], allowedOutputs: [...outputPlan.allowedOutputs, "content_pack"], outputs: [...outputPlan.outputs, { id: "pack-1", outputType: "content_pack", quantity: 1, destinations: ["content_pack"], evidenceRefs: [], costClass: "local", approvalClass: "strategy", childOutputIds: ["image-1", "video-1", "music-1"] }] };
    const initial = planRequestedMediaProduction({ job, outputPlan: mixed, pricing: { version: "test-pricing", canvasPerImage: "0.500000", reelPerSecond: "0.080000", musicPerSecond: "0.004000" } })!;
    const revised = bindTextArtifactsToMediaPack(initial, [{ id: "copy-1", contentDigest: "b".repeat(64), mimeType: "text/markdown" }]);
    expect(revised.revision).toBe(2);
    expect(revised.packTextChildren).toEqual([{ artifactId: "copy-1", digest: "b".repeat(64), mime: "text/markdown" }]);
    expect(productionPlanDigest(revised)).not.toBe(productionPlanDigest(initial));
    expect(compileProductionOperations(revised).find((operation) => operation.type === "assemble_media_pack")?.payload).toMatchObject({ packTextChildren: revised.packTextChildren });
  });

  it("keeps sealed text children in an image-and-music-only export graph", () => {
    const mediaOnly = { ...outputPlan, outputs: outputPlan.outputs.filter((output) => output.outputType !== "generated_video") };
    const initial = planRequestedMediaProduction({ job, outputPlan: mediaOnly, pricing: { version: "test", canvasPerImage: "0.500000", reelPerSecond: "0.080000", musicPerSecond: "0.004000" } })!;
    const revised = bindTextArtifactsToMediaPack(initial, [{ id: "copy-cafe", contentDigest: "c".repeat(64), mimeType: "text/markdown" }]);
    const exportOperation = compileProductionOperations(revised).find((operation) => operation.type === "assemble_export")!;
    expect(exportOperation.payload).toMatchObject({ packTextChildren: revised.packTextChildren });
    expect(exportOperation.requestDigest).not.toBe(compileProductionOperations(initial).find((operation) => operation.type === "assemble_export")!.requestDigest);
  });
});
