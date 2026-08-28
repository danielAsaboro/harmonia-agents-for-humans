import { afterAll, describe, expect, it } from "vitest";

import { firebasePrincipal, servicePrincipal } from "@/lib/authority";
import { db } from "@/lib/firestore";
import { compileProductionOperations, generatedMusicSpecSchema, generatedVideoSpecSchema, productionPlanDigest, videoProductionPlanSchema } from "@/lib/mediaProduction";
import {
  approveProductionPlan,
  claimPaidProductionOperation,
  getProductionPlan,
  getProductionPlanRevision,
  proposeProductionPlan,
  rejectProductionPlan,
  sealProductionPlan,
} from "@/lib/productionPlanStore";
import { runWithTenant } from "@/lib/tenancy";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const workspaceId = "production-plan-test";
const brandId = "brand-test";
const operatorScope = {
  workspaceId,
  brandId,
  principal: firebasePrincipal({
    subjectId: "operator-test",
    workspaceRole: "owner",
    authenticationId: "firebase-production-test",
  }),
};
const serviceScope = {
  workspaceId,
  brandId,
  principal: servicePrincipal("production-claim-test"),
};
const jobId = `production-${Date.now()}`;
const videoSpec = generatedVideoSpecSchema.parse({ modelCapability: "veo-3.1-fast", mode: "text_to_video", prompt: "Calm blue network", durationSec: 4, aspectRatio: "9:16", resolution: "1080p", generateAudio: false, enhancePrompt: true, outputCount: 1 });
const musicSpec = generatedMusicSpecSchema.parse({ modelCapability: "lyria-3-clip", prompt: "Warm minimal electronic soundtrack", instrumental: true, lyricsMode: "none", language: "en", targetDurationSec: 30, outputCount: 1 });
const basePlan = videoProductionPlanSchema.parse({
  id: "plan-1",
  jobId,
  workspaceId,
  brandId,
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
});

describe.skipIf(!emulator)("production plan Firestore aggregate", () => {
  it("persists immutable revisions and invalidates the active mandate after a material revision", async () => {
    await db().doc(`workspaces/${workspaceId}`).set({ defaultBrandId: brandId });
    await db().doc(`workspaces/${workspaceId}/jobs/${jobId}`).set({
      workspaceId, brandId, status: "running", stage: "draft",
      createdAt: "2026-08-31T09:00:00.000Z", updatedAt: "2026-08-31T09:00:00.000Z",
    });

    await runWithTenant(serviceScope, () => proposeProductionPlan(basePlan, "2026-08-31T10:00:00.000Z"));
    const proposed = await runWithTenant(operatorScope, () => getProductionPlan(basePlan.id));
    expect(proposed).toMatchObject({
      id: basePlan.id,
      state: "proposed",
      currentRevision: 1,
      currentPlanDigest: productionPlanDigest(basePlan),
      activeMandateId: null,
    });

    await runWithTenant(operatorScope, () => sealProductionPlan(basePlan.id, {
      planDigest: productionPlanDigest(basePlan),
      sealedAt: "2026-08-31T10:05:00.000Z",
    }));
    const mandate = await runWithTenant(operatorScope, () => approveProductionPlan(basePlan.id, {
      planDigest: productionPlanDigest(basePlan),
      approvedAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const paidOperation = compileProductionOperations(basePlan).find((operation) => operation.type === "generate_video")!;
    const claims = await runWithTenant(serviceScope, () => Promise.all([
      claimPaidProductionOperation(basePlan.id, paidOperation.id, {
        claimToken: "worker-a",
      }),
      claimPaidProductionOperation(basePlan.id, paidOperation.id, {
        claimToken: "worker-b",
      }),
    ]));
    expect(claims.map((claim) => claim.outcome).sort()).toEqual(["execute", "in_progress"]);
    expect(claims[0].claim).toMatchObject({
      planRevision: 1,
      planDigest: productionPlanDigest(basePlan),
      operationId: paidOperation.id,
      requestDigest: paidOperation.requestDigest,
      mandateId: mandate.id,
      state: "claimed",
      reservedCostUsd: "0.320000",
    });
    expect(await runWithTenant(operatorScope, () => getProductionPlan(basePlan.id))).toMatchObject({
      currentMandateReservedCostUsd: "0.320000",
    });
    const musicOperation = compileProductionOperations(basePlan).find((operation) => operation.type === "generate_music")!;
    const musicClaim = await runWithTenant(serviceScope, () => claimPaidProductionOperation(
      basePlan.id,
      musicOperation.id,
      { claimToken: "worker-music" },
    ));
    expect(musicClaim).toMatchObject({ outcome: "execute", claim: { reservedCostUsd: "0.120000" } });
    expect(await runWithTenant(operatorScope, () => getProductionPlan(basePlan.id))).toMatchObject({
      currentMandateReservedCostUsd: "0.440000",
    });

    const revisedVideo = { ...basePlan.scenes[0].video!, prompt: "Amber network with measured motion" };
    const revisionTwo = videoProductionPlanSchema.parse({
      ...basePlan,
      revision: 2,
      scenes: [{ ...basePlan.scenes[0], video: revisedVideo }],
      operationCostsUsd: {
        "plan-1:generate_video:scene-1": "0.320000",
        "plan-1:generate_music": "0.120000",
      },
    });
    await runWithTenant(serviceScope, () => proposeProductionPlan(revisionTwo, "2026-08-31T10:40:00.000Z"));

    const [current, original] = await runWithTenant(operatorScope, () => Promise.all([
      getProductionPlan(basePlan.id),
      getProductionPlanRevision(basePlan.id, 1),
    ]));
    expect(current).toMatchObject({ state: "proposed", currentRevision: 2, activeMandateId: null });
    expect(original?.plan).toEqual(basePlan);
    await expect(runWithTenant(serviceScope, () => claimPaidProductionOperation(
      basePlan.id,
      paidOperation.id,
      {
        claimToken: "worker-c",
      },
    ))).rejects.toThrow(/active production mandate/i);

    await runWithTenant(serviceScope, () => sealProductionPlan(revisionTwo.id, {
      planDigest: productionPlanDigest(revisionTwo),
    }));
    const revisionTwoMandate = await runWithTenant(operatorScope, () => approveProductionPlan(revisionTwo.id, {
      planDigest: productionPlanDigest(revisionTwo),
      expiresAt: "2099-01-01T00:00:00.000Z",
    }));
    const revisionTwoOperation = compileProductionOperations(revisionTwo).find((operation) => operation.type === "generate_video")!;
    const revisionTwoClaim = await runWithTenant(serviceScope, () => claimPaidProductionOperation(
      revisionTwo.id,
      revisionTwoOperation.id,
      { claimToken: "worker-v2" },
    ));
    expect(revisionTwoClaim).toMatchObject({
      outcome: "execute",
      claim: { planRevision: 2, mandateId: revisionTwoMandate.id, requestDigest: revisionTwoOperation.requestDigest },
    });
  });

  it("persists an immutable rejection decision with verified operator provenance", async () => {
    const rejectedPlan = videoProductionPlanSchema.parse({
      ...basePlan,
      id: "plan-reject",
      operationCostsUsd: {
        "plan-reject:generate_video:scene-1": "0.320000",
        "plan-reject:generate_music": "0.120000",
      },
    });
    const digest = productionPlanDigest(rejectedPlan);
    await runWithTenant(serviceScope, () => proposeProductionPlan(rejectedPlan, "2026-08-31T10:00:00.000Z"));
    await runWithTenant(serviceScope, () => sealProductionPlan(rejectedPlan.id, {
      planDigest: digest,
      sealedAt: "2026-08-31T10:05:00.000Z",
    }));
    const rejected = await runWithTenant(operatorScope, () => rejectProductionPlan(rejectedPlan.id, {
      planDigest: digest,
      feedback: "Use the source footage instead",
      rejectedAt: "2026-08-31T10:06:00.000Z",
    }));
    expect(rejected).toMatchObject({ state: "rejected", activeMandateId: null });
    const decision = await db().doc(
      `workspaces/${workspaceId}/brands/${brandId}/production_plans/${rejectedPlan.id}/decisions/v1`,
    ).get();
    expect(decision.data()).toMatchObject({
      decision: "rejected",
      planDigest: digest,
      actorSubjectId: "operator-test",
      authenticationId: "firebase-production-test",
      feedback: "Use the source footage instead",
    });
  });

  afterAll(async () => {
    if (emulator) await db().recursiveDelete(db().doc(`workspaces/${workspaceId}`));
  });
});
