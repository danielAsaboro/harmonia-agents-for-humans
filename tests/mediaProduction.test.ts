import { describe, expect, it } from "vitest";
import {
  assertProductionMandateAuthorizes,
  compileProductionOperations,
  createProductionMandate,
  estimateGeneratedMediaCost,
  generatedMusicSpecSchema,
  generatedVideoSpecSchema,
  mediaOperationSchema,
  productionApprovalStillValid,
  productionPlanDigest,
  transitionMediaOperation,
  videoProductionPlanSchema,
} from "@/lib/mediaProduction";

const videoSpec = generatedVideoSpecSchema.parse({
  modelCapability: "veo-3.1-fast", mode: "text_to_video", prompt: "Abstract data streams forming a calm blue network", durationSec: 4,
  aspectRatio: "9:16", resolution: "1080p", generateAudio: false, enhancePrompt: true, outputCount: 1,
});
const musicSpec = generatedMusicSpecSchema.parse({
  modelCapability: "lyria-3-clip", prompt: "Warm minimal electronic soundtrack, 100 BPM", instrumental: true,
  lyricsMode: "none", language: "en", targetDurationSec: 30, outputCount: 1,
});
const basePlan = {
  id: "plan-1",
  jobId: "job-1",
  workspaceId: "workspace-1",
  brandId: "brand-1",
  revision: 1,
  goal: "Create a product launch reel",
  audience: "technical startup founders",
  tone: ["confident", "clear"],
  target: { platform: "linkedin", durationSec: 30, aspectRatio: "9:16", resolution: "1080p", frameRate: 30, format: "mp4" },
  scenes: [{
    id: "scene-1", order: 1, startSec: 0, durationSec: 4,
    purpose: "establish the product", sourceArtifactIds: [],
    video: videoSpec,
    overlays: [], captions: [], transitions: [],
  }],
  soundtrack: musicSpec,
  constraints: { allowLikeness: false, allowGeneratedVocals: false, requireLicensedSources: true },
  pricingVersion: "2026-08-31",
  operationCostsUsd: {
    "plan-1:generate_video:scene-1": "0.320000",
    "plan-1:generate_music": "0.120000",
  },
  estimatedCostUsd: "0.440000",
  maximumCostUsd: "0.500000",
} as const;

describe("media production contracts", () => {
  it("rejects a Veo capability combination the selected model cannot execute", () => {
    expect(() => generatedVideoSpecSchema.parse({
      modelCapability: "veo-3.1-fast", mode: "extend_video", prompt: "continue",
      sourceVideoArtifactId: "asset-1", durationSec: 4, aspectRatio: "9:16",
      resolution: "4k", generateAudio: false, enhancePrompt: true, outputCount: 1,
    })).toThrow(/resolution/i);
  });

  it("blocks provider controls whose real conditioning path is not implemented", () => {
    expect(() => generatedVideoSpecSchema.parse({
      ...basePlan.scenes[0].video,
      mode: "image_to_video",
      sourceImageArtifactId: "image-1",
    })).toThrow(/mode/i);
    expect(() => generatedMusicSpecSchema.parse({
      ...basePlan.soundtrack,
      conditioningImageArtifactId: "image-1",
    })).toThrow(/conditioning|control/i);
  });

  it("blocks source-backed scenes until verified source materialization is implemented", () => {
    expect(() => videoProductionPlanSchema.parse({
      ...basePlan,
      scenes: [{ ...basePlan.scenes[0], sourceArtifactIds: ["artifact-1"] }],
    })).toThrow(/source artifact.*unavailable/i);
    expect(() => videoProductionPlanSchema.parse({
      ...basePlan,
      scenes: [{ ...basePlan.scenes[0], video: undefined, sourceArtifactIds: [] }],
    })).toThrow(/generated video.*required/i);
  });

  it("rejects Lyria lyrics when instrumental mode is selected", () => {
    expect(() => generatedMusicSpecSchema.parse({
      modelCapability: "lyria-3-clip", prompt: "bright pop",
      instrumental: true, lyricsMode: "provided", providedLyrics: "hello",
      language: "en", targetDurationSec: 30, outputCount: 1,
    })).toThrow(/lyrics/i);
  });

  it("produces a stable digest and invalidates approval after a material revision", () => {
    const parsed = videoProductionPlanSchema.parse(basePlan);
    const digest = productionPlanDigest(parsed);
    const reordered = Object.fromEntries(Object.entries(basePlan).reverse());
    expect(productionPlanDigest(videoProductionPlanSchema.parse(reordered))).toBe(digest);
    expect(productionApprovalStillValid({ planDigest: digest, planRevision: 1, expiresAt: "2099-01-01T00:00:00.000Z" }, parsed, new Date("2026-08-31T00:00:00.000Z"))).toBe(true);
    expect(productionApprovalStillValid({ planDigest: digest, planRevision: 1, expiresAt: "2099-01-01T00:00:00.000Z" }, { ...parsed, revision: 2 }, new Date("2026-08-31T00:00:00.000Z"))).toBe(false);
  });

  it("seals exact paid calls, scope, operator identity, and maximum cost", () => {
    const parsed = videoProductionPlanSchema.parse(basePlan);
    const mandate = createProductionMandate(parsed, {
      operatorSubjectId: "operator-1",
      authenticationId: "session-1",
      approvedAt: "2026-08-31T10:00:00.000Z",
      expiresAt: "2026-08-31T11:00:00.000Z",
    });
    expect(mandate).toMatchObject({
      jobId: parsed.jobId,
      workspaceId: parsed.workspaceId,
      brandId: parsed.brandId,
      maximumCostUsd: parsed.maximumCostUsd,
      operatorSubjectId: "operator-1",
    });
    expect(mandate.paidOperationDigests).toEqual(
      compileProductionOperations(parsed)
        .filter((operation) => operation.executionAuthority === "production_mandate")
        .map((operation) => operation.requestDigest),
    );
    expect(productionApprovalStillValid(mandate, parsed, new Date("2026-08-31T10:30:00.000Z"))).toBe(true);
    expect(productionApprovalStillValid({ ...mandate, paidOperationDigests: [] }, parsed, new Date("2026-08-31T10:30:00.000Z"))).toBe(false);
  });

  it("authorizes only an exact paid operation while the current mandate is active", () => {
    const plan = videoProductionPlanSchema.parse(basePlan);
    const operation = compileProductionOperations(plan).find((candidate) => candidate.type === "generate_video")!;
    const mandate = createProductionMandate(plan, {
      operatorSubjectId: "operator-1",
      authenticationId: "session-1",
      approvedAt: "2026-08-31T10:00:00.000Z",
      expiresAt: "2026-08-31T11:00:00.000Z",
    });

    expect(assertProductionMandateAuthorizes({
      mandate,
      plan,
      operation,
      activeMandateId: mandate.id,
      workspaceId: plan.workspaceId,
      brandId: plan.brandId,
      now: new Date("2026-08-31T10:30:00.000Z"),
    })).toBe(operation);

    expect(() => assertProductionMandateAuthorizes({
      mandate,
      plan: { ...plan, revision: 2 },
      operation,
      activeMandateId: mandate.id,
      workspaceId: plan.workspaceId,
      brandId: plan.brandId,
      now: new Date("2026-08-31T10:30:00.000Z"),
    })).toThrow(/current plan/i);
    expect(() => assertProductionMandateAuthorizes({
      mandate,
      plan,
      operation: compileProductionOperations(plan).find((candidate) => candidate.type === "build_composition")!,
      activeMandateId: mandate.id,
      workspaceId: plan.workspaceId,
      brandId: plan.brandId,
      now: new Date("2026-08-31T10:30:00.000Z"),
    })).toThrow(/paid operation/i);
    expect(() => assertProductionMandateAuthorizes({
      mandate,
      plan,
      operation,
      activeMandateId: null,
      workspaceId: plan.workspaceId,
      brandId: plan.brandId,
      now: new Date("2026-08-31T10:30:00.000Z"),
    })).toThrow(/inactive/i);
    expect(() => assertProductionMandateAuthorizes({
      mandate,
      plan,
      operation,
      activeMandateId: mandate.id,
      workspaceId: plan.workspaceId,
      brandId: plan.brandId,
      now: new Date("2026-08-31T11:00:00.000Z"),
    })).toThrow(/expired/i);
    expect(() => assertProductionMandateAuthorizes({
      mandate,
      plan,
      operation,
      activeMandateId: mandate.id,
      workspaceId: plan.workspaceId,
      brandId: plan.brandId,
      now: new Date("2026-08-31T09:59:59.000Z"),
    })).toThrow(/not active/i);
  });

  it("prices Veo from duration and rejects unpriced preview Lyria without an override", () => {
    const plan = videoProductionPlanSchema.parse(basePlan);
    expect(estimateGeneratedMediaCost(plan.scenes[0].video!)).toBe("0.320000");
    expect(() => estimateGeneratedMediaCost(plan.soundtrack!)).toThrow(/pricing unavailable/i);
    expect(estimateGeneratedMediaCost(plan.soundtrack!, { "lyria-3-clip": "0.120000" })).toBe("0.120000");
  });

  it("rejects a plan whose signed operation quotes do not exactly fund its paid graph", () => {
    expect(() => videoProductionPlanSchema.parse({
      ...basePlan,
      operationCostsUsd: { "plan-1:generate_video:scene-1": "0.000001" },
    })).toThrow(/operation cost quotes/i);
  });

  it("itemizes repeated identical paid requests as distinct operation costs", () => {
    const repeated = {
      ...basePlan,
      scenes: [
        basePlan.scenes[0],
        { ...basePlan.scenes[0], id: "scene-2", order: 2, startSec: 4 },
      ],
      operationCostsUsd: {
        "plan-1:generate_video:scene-1": "0.320000",
        "plan-1:generate_video:scene-2": "0.320000",
        "plan-1:generate_music": "0.120000",
      },
      estimatedCostUsd: "0.760000",
      maximumCostUsd: "0.800000",
    };
    const operations = compileProductionOperations(videoProductionPlanSchema.parse(repeated));
    expect(operations.filter((operation) => operation.type === "generate_video").map((operation) => operation.estimatedCostUsd))
      .toEqual(["0.320000", "0.320000"]);
  });

  it("compiles paid media before composition and finalization", () => {
    const operations = compileProductionOperations(videoProductionPlanSchema.parse(basePlan));
    expect(operations.map((operation) => operation.type)).toEqual([
      "generate_video", "generate_music", "build_composition", "render_composition",
      "mix_audio", "ffmpeg_finalize", "inspect_media", "evaluate_production", "repair_media",
      "inspect_delivery", "evaluate_delivery", "assemble_export",
    ]);
    expect(operations[2].dependsOn).toEqual([operations[0].id, operations[1].id]);
    expect(operations.at(-1)?.dependsOn).toEqual([
      "plan-1:repair_media", "plan-1:evaluate_delivery",
    ]);
    expect(operations.slice(0, 2).map((operation) => operation.estimatedCostUsd)).toEqual(["0.320000", "0.120000"]);
  });

  it("models provider pending as a durable nonterminal state", () => {
    const operation = mediaOperationSchema.parse({
      id: "media-1", jobId: "job-1", actionId: "action-1", provider: "veo",
      state: "provider_pending", providerOperationId: "operations/123", attempt: 1,
      requestDigest: "a".repeat(64), estimatedCostUsd: "0.320000",
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:10.000Z",
    });
    expect(operation.state).toBe("provider_pending");
    expect(transitionMediaOperation(operation, "provider_succeeded", "2026-08-31T00:01:00.000Z").state).toBe("provider_succeeded");
    expect(() => transitionMediaOperation(operation, "prepared", "2026-08-31T00:01:00.000Z")).toThrow(/transition/i);
  });
});
