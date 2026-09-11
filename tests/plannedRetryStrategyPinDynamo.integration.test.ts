import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { configurePlanningPolicy, readItemState, readPlannedItem } from "@/lib/campaigns/repository";
import { resolveDecision } from "@/lib/decisions";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import { actionPayloadDigest } from "@/lib/idempotency";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { addPlannedDeliverable, materializeIntake } from "@/lib/planning/commands";
import { claimNextPlannedItem } from "@/lib/planning/selection";
import { buildStageMessage } from "@/lib/queue";
import { getJob, markFailed, retryFailedJobWithOutbox } from "@/lib/repository";
import { readActiveStrategyRef } from "@/lib/strategy/repository";
import { insertStrategyProposal, decideStrategyProposal } from "@/lib/strategy/repository";
import { strategyDigest } from "@/lib/strategyApproval";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { withTraceContext } from "@/lib/telemetry";
import type { StageOutboxRecord } from "@/lib/stageOutbox";
import { strategyFixture } from "./fixtures/strategy";
import { campaignWorkerBridge } from "./fixtures/campaignWorkerBridge";

const tenant = (): TenantContext => ({
  workspaceId: `pinned-retry-${randomUUID()}`,
  brandId: "brand-a",
  principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" },
});

async function setup(outputs: Array<"x_post" | "content_pack"> = ["x_post"]) {
  const strategy = strategyFixture("pinned-retry-strategy");
  const digest = strategyDigest(strategy);
  const proposal = await awsRepository().atomic(tx => insertStrategyProposal(tx, {
    jobId: `strategy-${randomUUID()}`,
    attempt: 1,
    strategy,
    digest,
    evidenceLineage: ["operator-context"],
    invocationContext: { revision: 1, sourceIds: [], operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] },
    proposedAt: new Date().toISOString(),
    expiresAt: "2099-01-01T00:00:00Z",
  }));
  const approved = await awsRepository().atomic(tx => decideStrategyProposal(tx, proposal.id, { decision: "approved", payloadDigest: digest, expectedActiveRevision: 0 }));
  await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 8, maxItemsPerWeek: 8 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 8 }, maxConcurrentItems: 1 }, 0);
  const draft = await submitIntakeTurn({
    requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard",
    message: "Write a creative founder invitation and export the approved content pack; make no factual claims.",
    advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "Invite founders", requestedOutputs: outputs, sourceHandles: [], targetName: "Founder invitation" },
  });
  const planned = await materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
  return { approved: approved.strategyRef!, planned };
}

async function promoteStrategy() {
  const learning = await import("@/lib/learning/proposals");
  const active = (await readActiveStrategyRef())!;
  const feedback = await learning.recordOperatorFeedback({ requestId: randomUUID(), text: "Use a shorter invitation CTA in future work.", sourceIds: [] });
  const proposal = await learning.createStrategyChangeProposal({
    requestId: randomUUID(), baseStrategyRef: active,
    changes: [{ type: "cta_guidance", value: ["Ask founders to reply with one sentence"] }],
    rationale: "Operator feedback for later work",
    evidenceRefs: [{ id: feedback.id, digest: feedback.digest }], contradictionRefs: [],
  });
  return (await learning.decideStrategyChange({ id: proposal.id, revision: proposal.revision, digest: proposal.digest, decision: "approved" })).approvedStrategyRef!;
}

async function failTransient(jobId: string) {
  await markFailed({
    jobId, stage: "draft", category: "provider_transient", code: "temporary_draft_dependency",
    publicMessage: "Draft dependency temporarily unavailable", retryable: true,
    operationId: `job:${jobId}:stage:draft:generation:0`, traceId: "a".repeat(32), attempt: 1, maxAttempts: 3, details: {},
  });
}

async function runStage(bridge: Awaited<ReturnType<typeof campaignWorkerBridge>>, workspaceId: string, jobId: string, stage: string, expectedOutboxId?: string) {
  const rows = await awsRepository().query(partition(`workspaces/${workspaceId}/stage_outbox`));
  const outbox = rows.rows.find(row => row.value?.jobId === jobId && row.value?.stage === stage && row.value?.state === "pending" && (!expectedOutboxId || row.value?.id === expectedOutboxId))?.value as StageOutboxRecord | undefined;
  if (!outbox) throw new Error(`missing pending ${stage} outbox for ${jobId}`);
  const message = buildStageMessage({ workspaceId, brandId: "brand-a" }, outbox);
  const result = await bridge.run({ event: JSON.parse(message.data.toString()), carrier: message.attributes, transportId: randomUUID() });
  expect(result.result.failed, JSON.stringify(bridge.requests)).not.toBe(true);
  return result;
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("planned retries keep their immutable strategy pin", () => {
  it("retries the same claimed job after strategy promotion and completes a verified export with its original strategy", async () => {
    const scope = tenant();
    await runWithTenant(scope, async () => {
      vi.stubEnv("INTERNAL_API_TOKEN", "pinned-retry-worker-token");
      vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1");
      vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
      const bridge = await campaignWorkerBridge();
      try {
        const { approved, planned } = await setup(["x_post", "content_pack"]);
        const claim = (await claimNextPlannedItem(planned.planRef.id))!;
        expect((await getJob(claim.jobId)).strategyRef).toEqual(approved);
        const promoted = await promoteStrategy();
        expect(promoted).not.toEqual(approved);
        await failTransient(claim.jobId);
        const failed = await getJob(claim.jobId);

        const retryOutboxId = await retryFailedJobWithOutbox(claim.jobId, "draft");
        expect(retryOutboxId).toBeTruthy();
        expect(await readItemState(claim.itemRef)).toMatchObject({ status: "running", jobId: claim.jobId, outboxId: retryOutboxId, retryPending: false });
        const retried = await getJob(claim.jobId);
        expect(retried).toMatchObject({ controlEpoch: 1, strategyRef: approved, budget: failed.budget });

        await runStage(bridge, scope.workspaceId, claim.jobId, "draft", retryOutboxId!);
        const awaiting = await getJob(claim.jobId);
        const pack = awaiting.actions.find(action => action.type === "export_content_artifact" && action.payload.outputType === "content_pack")!;
        expect(pack).toMatchObject({ approvalState: "pending" });
        expect(awaiting.actions.every(action => action.type === "export_content_artifact")).toBe(true);
        for (const action of awaiting.actions.filter(candidate => candidate.approvalState === "pending")) {
          await withTraceContext(new Headers(), () => resolveDecision(claim.jobId, action.id, "approved", actionPayloadDigest(action)));
        }
        for (const stage of ["publish", "verify", "learn"]) await runStage(bridge, scope.workspaceId, claim.jobId, stage);
        let completed = await getJob(claim.jobId);
        if (completed.stage === "complete" && completed.terminalOutcome !== "succeeded") {
          await runStage(bridge, scope.workspaceId, claim.jobId, "complete");
          completed = await getJob(claim.jobId);
        }
        expect(completed).toMatchObject({ terminalOutcome: "succeeded", strategyRef: approved });
        expect(completed.actions.find(action => action.id === pack.id)).toMatchObject({ state: "executed" });
        expect(completed.verifications).toContainEqual(expect.objectContaining({ verified: true, method: "artifact_digest_reread" }));
        expect(await readItemState(claim.itemRef)).toMatchObject({ status: "completed", jobId: claim.jobId });
      } finally {
        await bridge.close();
        vi.unstubAllEnvs();
      }
    });
  }, 60_000);

  it("blocks the pinned retry while another claimed item occupies production capacity", async () => runWithTenant(tenant(), async () => {
    const { planned } = await setup();
    const first = (await claimNextPlannedItem(planned.planRef.id))!;
    const appended = await addPlannedDeliverable({ planId: planned.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second invitation", operatorBrief: "Write another creative invitation.", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-01T12:00:00Z", dependencies: [], requiredAssetIds: [] });
    await failTransient(first.jobId);
    const second = (await claimNextPlannedItem(appended.planRef.id))!;
    await promoteStrategy();
    const before = await getJob(first.jobId);
    expect(await retryFailedJobWithOutbox(first.jobId, "draft")).toBeNull();
    expect(await getJob(first.jobId)).toMatchObject({ controlEpoch: before.controlEpoch, failure: before.failure, budget: before.budget, strategyRef: before.strategyRef, plannedItemRef: before.plannedItemRef });
    expect(await readItemState(first.itemRef)).toMatchObject({ status: "failed", jobId: first.jobId, retryPending: true, reason: expect.stringContaining("production concurrency occupied") });
    expect(await readItemState(second.itemRef)).toMatchObject({ status: "running", jobId: second.jobId });
  }));

  it("blocks retry when the claimed job has an unknown effect outcome", async () => runWithTenant(tenant(), async () => {
    const { planned } = await setup();
    const claim = (await claimNextPlannedItem(planned.planRef.id))!;
    await promoteStrategy();
    await failTransient(claim.jobId);
    await awsRepository().put(recordKey(`workspaces/${claim.itemRef.workspaceId}/operations/unknown-${randomUUID()}`), { workspaceId: claim.itemRef.workspaceId, brandId: claim.itemRef.brandId, jobId: claim.jobId, state: "unknown" });
    const before = await getJob(claim.jobId);
    expect(await retryFailedJobWithOutbox(claim.jobId, "draft")).toBeNull();
    expect(await getJob(claim.jobId)).toMatchObject({ controlEpoch: before.controlEpoch, failure: before.failure, budget: before.budget, strategyRef: before.strategyRef, plannedItemRef: before.plannedItemRef });
    expect(await readItemState(claim.itemRef)).toMatchObject({ status: "failed", jobId: claim.jobId, retryPending: true, reason: expect.stringContaining("unknown effect outcome requires reconciliation") });
  }));

  it("keeps unclaimed work on the old strategy blocked for explicit disposition", async () => runWithTenant(tenant(), async () => {
    const { planned } = await setup();
    const item = await readPlannedItem(planned.itemRefs[0]);
    await promoteStrategy();
    expect(await claimNextPlannedItem(planned.planRef.id)).toBeNull();
    expect(await readItemState(item.ref)).toMatchObject({ status: "requires_disposition", dispositionProposalId: expect.any(String) });
    expect((await awsRepository().query(partition(`workspaces/${item.workspaceId}/jobs`))).rows).toHaveLength(0);
  }));

  it("rejects an old-strategy retry when the persisted job no longer matches its claimed strategy authority", async () => runWithTenant(tenant(), async () => {
    const { planned } = await setup();
    const claim = (await claimNextPlannedItem(planned.planRef.id))!;
    const promoted = await promoteStrategy();
    await failTransient(claim.jobId);
    await awsRepository().patch(recordKey(`workspaces/${claim.itemRef.workspaceId}/jobs/${claim.jobId}`), { strategyRef: promoted });
    expect(await retryFailedJobWithOutbox(claim.jobId, "draft")).toBeNull();
    expect(await readItemState(claim.itemRef)).toMatchObject({
      status: "failed",
      jobId: claim.jobId,
      retryPending: true,
      reason: expect.stringContaining("claimed transient retry authority does not match"),
    });
  }));
});
