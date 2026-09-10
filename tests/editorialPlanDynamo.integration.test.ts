import { recordKey, awsRepository } from "../src/lib/dynamo";
import { afterAll, describe, expect, it } from "vitest";

import { servicePrincipal } from "@/lib/authority";
import { editorialPlanDigest, editorialPlanningSnapshotDigest } from "@/lib/editorialPlan";
import { acceptEditorialPlan, db, getJob } from "@/lib/repository";
import { runWithTenant } from "@/lib/tenancy";
import type { EditorialPlan } from "@/lib/types";
import { insertStrategyProposal, decideStrategyProposal } from "@/lib/strategy/repository";
import { strategyDigest as calculateStrategyDigest } from "@/lib/strategyApproval";
import { strategyFixture } from "./fixtures/strategy";

const emulator = process.env.AWS_LOCAL_ENDPOINT;
const scope = { workspaceId: "temi-plan-test", brandId: "brand-test", principal: servicePrincipal("temi-plan-integration") };
const otherScope = { workspaceId: "temi-plan-other", brandId: "brand-test", principal: servicePrincipal("temi-plan-integration") };
const jobId = `temi-plan-${Date.now()}`;
const strategy = strategyFixture("strategy-1");
const strategyDigest = calculateStrategyDigest(strategy);
const snapshot = {
  snapshotId: `planning-${jobId}-v1`, asOf: "2026-08-27T00:00:00Z",
  horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "UTC",
  channelCapabilities: [{ channel: "x", formats: ["thread"] }], existingCommitments: [],
  productionCapacity: { maxItems: 8, maxItemsPerWeek: 2 }, cadenceConstraints: { minimumHoursBetweenItems: 24, maxItemsPerChannelPerWeek: 2 },
  postingWindowObservations: [], assetReadiness: [], blockedDependencies: [], calendarProjection: [],
  provenanceIds: ["policy:editorial-planning-v1"],
};
const snapshotDigest = editorialPlanningSnapshotDigest(snapshot);
const campaignOutputPlan = {
  id: "output-plan-1", digest: "b".repeat(64), desiredOutputs: ["x_post"], allowedOutputs: ["x_post"],
  outputs: [{ id: "output-1", outputType: "x_post", quantity: 1, destinations: ["x"], evidenceRefs: ["source-1:seg-1"], costClass: "local", approvalClass: "effect" }],
};
const item = {
  id: "item-1", briefId: "brief-1", campaignTheme: "Proof", contentPillar: "Outcomes", objective: "Earn consideration",
  audienceId: "founders", funnelStage: "consideration" as const, intendedConversion: "Request demo", ctaIntent: "See workflow", kpi: "Qualified demos",
  channel: "x", format: "thread", evidenceRefs: ["moment-1", "context:campaign"],
  publicationWindowStartAt: "2026-09-01T16:00:00Z", publicationWindowEndAt: "2026-09-01T18:00:00Z", productionDeadlineAt: "2026-08-31T18:00:00Z",
  priority: 1, selectionScore: 0.9, dependencies: [], productionStatus: "planned" as const, constraints: ["No unsupported metrics"], requiredAssets: [],
  planningRationale: "Lead with proof.", selectionRationale: "Highest priority eligible item.", confidence: "high" as const,
};
const plan: EditorialPlan = {
  planId: "plan-1", version: 1, approvedStrategyDigest: strategyDigest,
  planningSnapshotId: snapshot.snapshotId, planningSnapshotDigest: snapshotDigest,
  horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "UTC",
  summary: "Proof campaign", sequencingRationale: "Proof before education", cadenceRationale: "One item per week",
  assumptions: ["Capacity remains available"], confidence: "high", items: [item], selectedNextItemId: item.id,
};

describe.skipIf(!emulator)("Temi editorial plan DynamoDB boundary", () => {
  it("round-trips the complete plan and binds it to tenant and approved strategy", async () => {
    const result = await runWithTenant(scope, async () => {
      const proposal = await db().atomic((tx) => insertStrategyProposal(tx, { jobId, attempt: 1, strategy, digest: strategyDigest, evidenceLineage: ["m1"], invocationContext: { revision: 1, sourceIds: ["m1"], operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
      return db().atomic((tx) => decideStrategyProposal(tx, proposal.id, { decision: "approved", payloadDigest: strategyDigest, expectedActiveRevision: 0 }));
    });
    const path = `workspaces/${scope.workspaceId}/jobs/${jobId}`;
    await awsRepository().put(recordKey(path), {
      workspaceId: scope.workspaceId, brandId: scope.brandId, createdByUserId: "operator-test",
      createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z", status: "running", stage: "plan",
      config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, strategyRef: result.strategyRef,
      editorialPlanningSnapshot: snapshot, editorialPlanningSnapshotDigest: snapshotDigest,
      campaignOutputPlan,
    });

    const accepted = await runWithTenant(scope, () => acceptEditorialPlan(jobId, plan, 1));
    const stored = await runWithTenant(scope, () => getJob(jobId));
    expect(stored.editorialPlan).toEqual(plan);
    expect(stored.editorialPlanDigest).toBe(editorialPlanDigest(plan));
    expect(stored.editorialPlanEvidenceLineage).toEqual(["context:campaign", "moment-1"]);
    expect(stored.editorialPlanHistory?.v1.plan).toEqual(plan);
    expect(stored.editorialPlanHistory?.v1.strategyDigest).toBe(strategyDigest);
    expect(stored.editorialItemStates).toEqual({ [item.id]: expect.objectContaining({ status: "selected" }) });
    expect(stored.campaignOutputPlan).toEqual(campaignOutputPlan);
    expect(accepted.selectedNextItemId).toBe(item.id);
    await expect(runWithTenant(otherScope, () => getJob(jobId))).rejects.toThrow("job not found");
  });

  afterAll(async () => {
    if (emulator) await db().removeTree(recordKey(`workspaces/${scope.workspaceId}`));
  });
});
