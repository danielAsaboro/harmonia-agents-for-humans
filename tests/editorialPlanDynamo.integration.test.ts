import { buildStrategySourceBinding } from "@/lib/strategy/sourceBinding";
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
import { configurePlanningPolicy } from "@/lib/campaigns/repository";
import { sealManifest } from "@/lib/sourceRegistry";
import { currentPlan, readItemState, readPlannedItem } from "@/lib/campaigns/repository";
import { addPlannedDeliverable, replanItem } from "@/lib/planning/commands";
import { reconcilePlannedExecution } from "@/lib/planning/selection";

const emulator = process.env.AWS_LOCAL_ENDPOINT;
const scope = { workspaceId: "temi-plan-test", brandId: "brand-test", principal: servicePrincipal("temi-plan-integration") };
const otherScope = { workspaceId: "temi-plan-other", brandId: "brand-test", principal: servicePrincipal("temi-plan-integration") };
const jobId = `temi-plan-${Date.now()}`;
const strategy = strategyFixture("strategy-1");
const strategyDigest = calculateStrategyDigest(strategy);
const sourceAnalysis = { sourceDigest: "c".repeat(64), summary: "Source proof", moments: [{ id: "moment-1", title: "Proof", startSec: 0, endSec: 1, hook: "Proof", quote: "Source proof", sourceSegmentRefs: ["source-1:seg-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" as const }], angles: [], assumptions: [], confidence: "high" as const };
const strategyRef = { workspaceId: scope.workspaceId, brandId: scope.brandId, strategyId: strategy.strategyId, revision: 1, digest: strategyDigest };
const snapshot = {
  sourceBinding: buildStrategySourceBinding({ id: jobId, strategyRef, sourceAnalysis }),
  snapshotId: `planning-${jobId}-v1`, asOf: "2026-08-27T00:00:00Z",
  horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "UTC",
  channelCapabilities: [{ channel: "x", formats: ["thread"] }], existingCommitments: [],
  productionCapacity: { maxItems: 8, maxItemsPerWeek: 2 }, cadenceConstraints: { minimumHoursBetweenItems: 24, maxItemsPerChannelPerWeek: 2 },
  postingWindowObservations: [], assetReadiness: [], blockedDependencies: [], calendarProjection: [],
  provenanceIds: ["policy:policy:v1"],
};
const snapshotDigest = editorialPlanningSnapshotDigest(snapshot);
const campaignOutputPlan = {
  id: "output-plan-1", digest: "b".repeat(64), desiredOutputs: ["x_post"], allowedOutputs: ["x_post"],
  outputs: [{ id: "output-1", outputType: "x_post", quantity: 1, destinations: ["x"], evidenceRefs: ["source-1:seg-1"], costClass: "local", approvalClass: "effect" }],
};
const item = {
  id: "item-1", briefId: "brief-1", campaignTheme: "Proof", contentPillar: "Outcomes", objective: "Earn consideration",
  audienceId: "founders", funnelStage: "consideration" as const, intendedConversion: "Request demo", ctaIntent: "See workflow", kpi: "Qualified demos",
  channel: "x", format: "thread", evidenceRefs: ["moment-1"],
  publicationWindowStartAt: "2026-09-01T16:00:00Z", publicationWindowEndAt: "2026-09-01T18:00:00Z", productionDeadlineAt: "2026-08-31T18:00:00Z",
  priority: 1, selectionScore: 0.9, dependencies: [], productionStatus: "planned" as const, constraints: ["No unsupported metrics"], requiredAssets: [],
  planningRationale: "Lead with proof.", selectionRationale: "Highest priority eligible item.", confidence: "high" as const,
};
const plan: EditorialPlan = {
  planId: "plan-1", version: 1, approvedStrategyDigest: strategyDigest,
  planningSnapshotId: snapshot.snapshotId, planningSnapshotDigest: snapshotDigest,
  horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "UTC",
  summary: "Proof campaign", sequencingRationale: "Proof before education", cadenceRationale: "One item per week",
  assumptions: ["Capacity remains available"], confidence: "high", items: [item, { ...item, id: "item-2", publicationWindowStartAt: "2026-09-08T16:00:00Z", publicationWindowEndAt: "2026-09-08T18:00:00Z", productionDeadlineAt: "2026-09-07T18:00:00Z", dependencies: [item.id] }], selectedNextItemId: item.id,
};

describe.skipIf(!emulator)("Temi editorial plan DynamoDB boundary", () => {
  it("round-trips the complete plan and binds it to tenant and approved strategy", async () => {
    await runWithTenant({ ...scope, principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } }, () => configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 8, maxItemsPerWeek: 2 }, cadenceConstraints: { minimumHoursBetweenItems: 24, maxItemsPerChannelPerWeek: 2 }, maxConcurrentItems: 1 }, 0));
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
      campaignOutputPlan, sourceAnalysis,
    });
    await awsRepository().put(recordKey(`${path}/source_manifests/manifest-1`), sealManifest({ id: "manifest-1", jobId, revision: 1, directSourceIds: ["source-1"], excludedSourceIds: [], exclusionRecords: [], sealedAt: new Date().toISOString(), sealedBySubjectId: "operator" }));

    const accepted = await runWithTenant(scope, () => acceptEditorialPlan(jobId, plan, 1));
    expect(accepted).toHaveProperty("planRef");
    expect(accepted).toHaveProperty("executionJobId");
    const stored = await runWithTenant(scope, () => getJob(accepted.executionJobId!));
    expect(stored.editorialPlan?.items).toEqual([plan.items[0]]);
    expect(stored.editorialPlanDigest).toBe(editorialPlanDigest(stored.editorialPlan));
    expect(stored.editorialPlanEvidenceLineage).toEqual(["moment-1"]);
    expect(stored.planRef).toEqual(accepted.planRef);
    expect((await awsRepository().read(recordKey(path))).value).not.toHaveProperty("editorialPlan");
    expect(stored.editorialItemStates).toEqual({ [item.id]: expect.objectContaining({ status: "selected" }) });
    expect(stored.campaignOutputPlan?.desiredOutputs).toEqual(["x_post"]);
    expect(accepted.selectedNextItemId).toBe(item.id);
    await expect(runWithTenant(otherScope, () => getJob(jobId))).rejects.toThrow("job not found");
    await runWithTenant({ ...scope, principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } }, async () => {
      await configurePlanningPolicy({ timezone: "Africa/Lagos", productionCapacity: { maxItems: 8, maxItemsPerWeek: 2 }, cadenceConstraints: { minimumHoursBetweenItems: 24, maxItemsPerChannelPerWeek: 2 }, maxConcurrentItems: 1 }, 1);
      expect((await acceptEditorialPlan(jobId, plan, 1)).planRef).toEqual(accepted.planRef);
      await expect(acceptEditorialPlan(jobId, { ...plan, version: 2 }, 2)).rejects.toThrow("already accepted");
      const durable = await currentPlan(accepted.planRef.id);
      const context = (await readPlannedItem(durable.itemRefs[1])).productionContextDigest;
      await addPlannedDeliverable({ planId: durable.ref.id, expectedRevision: durable.ref.revision, requestId: "append-creative", name: "Creative follow-up", operatorBrief: "Imagine the next step", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-21T12:00:00Z", dependencies: [], requiredAssetIds: [] });
      const changed = await replanItem({ itemRef: durable.itemRefs[1], scheduledFor: "2026-09-10T16:00:00Z", requestId: "reschedule-second" });
      expect(changed.outcome).toBe("applied");
      expect((await readPlannedItem(changed.itemRef!)).productionContextDigest).toBe(context);
      expect(await currentPlan(accepted.planRef.id)).not.toHaveProperty("editorial");
      await awsRepository().patch(recordKey(`workspaces/${scope.workspaceId}/jobs/${accepted.executionJobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
      await reconcilePlannedExecution(accepted.executionJobId!);
      const execution = await readItemState(changed.itemRef!);
      expect(execution.jobId).toBeTruthy();
      const projected = await getJob(execution.jobId!);
      const selected = projected.editorialPlan!.items.find(item => item.id === "item-2")!;
      expect(selected.publicationWindowStartAt).toBe("2026-09-10T16:00:00.000Z");
      expect(selected.publicationWindowEndAt).toBe("2026-09-10T18:00:00.000Z");
      expect(selected.productionDeadlineAt).toBe("2026-09-09T18:00:00.000Z");
    });
  });

  afterAll(async () => {
    if (emulator) await db().removeTree(recordKey(`workspaces/${scope.workspaceId}`));
  });
});
