import { describe, expect, it } from "vitest";
import { planOutputProjection, proposeOutputPlan, validateOutputEligibility } from "@/lib/outputPlanning";
import { outputKindSchema } from "@/lib/contracts";
import type { NormalizedSource, OutputKind } from "@/lib/types";
const document: NormalizedSource = { sourceId: "s1", sourceKind: "document", title: "Brief", mimeType: "application/pdf", contentDigest: "a".repeat(64), extractorVersion: "pdf-v1", extractedAt: "2026-08-30T00:00:00Z", extractionReceiptId: "r1", metadata: {}, segments: [{ id: "p1", text: "Proof", digest: "b".repeat(64), locator: { kind: "page_range", startPage: 1, endPage: 1 } }] };
const plan = (outputs: OutputKind[]) => ({ allowedOutputs: outputs, outputs: outputs.map((outputType) => ({ id: outputType, outputType, quantity: 1, destinations: [], evidenceRefs: ["s1:p1"], costClass: "local" as const, approvalClass: "strategy" as const })) });
describe("output modality eligibility", () => {
  it("allows text and image outputs from document evidence", () => expect(validateOutputEligibility(plan(["x_post", "linkedin_post", "social_image"]), [document])).toEqual([]));
  it("rejects source clips without video time evidence", () => expect(validateOutputEligibility(plan(["short_clip"]), [document])).toContainEqual(expect.objectContaining({ code: "video_evidence_required" })));
  it("keeps generated video distinct from source clips", () => { expect(outputKindSchema.parse("generated_video")).toBe("generated_video"); expect(outputKindSchema.parse("short_clip")).toBe("short_clip"); });
  it("keeps an unconfigured media request as an exact reviewable proposal", () => {
    const proposal = proposeOutputPlan("job-1", ["generated_music"], ["generated_music"], { sourceDigest: "a".repeat(64), summary: "Proof", moments: [{ id: "m1", title: "Proof", startSec: 0, endSec: 1, hook: "Hook", quote: "Proof", sourceSegmentRefs: ["s1:p1"], visualEvidenceIds: [], assumptions: [], confidence: "high" }], angles: [], assumptions: [], confidence: "high" });
    expect(proposal.desiredOutputs).toEqual(["generated_music"]);
    expect(proposal.outputs).toEqual([expect.objectContaining({
      outputType: "generated_music",
      costClass: "provider_metered",
      providerAvailability: "not_configured",
      liveVerification: "not_verified",
    })]);
  });
  it("binds a content pack to its requested media children", () => {
    const proposal = proposeOutputPlan("job-1", ["social_image", "generated_video", "content_pack"], ["social_image", "generated_video", "content_pack"], { sourceDigest: "a".repeat(64), summary: "Proof", moments: [{ id: "m1", title: "Proof", startSec: 0, endSec: 1, hook: "Hook", quote: "Proof", sourceSegmentRefs: ["s1:p1"], visualEvidenceIds: [], assumptions: [], confidence: "high" }], angles: [], assumptions: [], confidence: "high" });
    const pack = proposal.outputs.find((output) => output.outputType === "content_pack");
    expect(pack).toMatchObject({
      childOutputIds: ["output-1-social_image", "output-2-generated_video"],
      evidenceRefs: ["s1:p1"],
    });
  });
  it("reconstructs only a missing derived output projection from persisted authority", () => {
    const analysis = { sourceDigest: "a".repeat(64), summary: "Proof", moments: [{ id: "m1", title: "Proof", startSec: 0, endSec: 1, hook: "Hook", quote: "Proof", sourceSegmentRefs: ["s1:p1"], visualEvidenceIds: [], assumptions: [], confidence: "high" as const }], angles: [], assumptions: [], confidence: "high" as const };
    const recovered = planOutputProjection("job-1", undefined, ["linkedin_post"], ["linkedin_post"], analysis);
    expect(recovered.outcome).toBe("reconstructed");
    expect(recovered.plan.outputs.map((item) => item.outputType)).toEqual(["linkedin_post"]);
    expect(planOutputProjection("job-1", recovered.plan, ["linkedin_post"], ["linkedin_post"], analysis)).toEqual({ outcome: "existing", plan: recovered.plan });
  });
});
