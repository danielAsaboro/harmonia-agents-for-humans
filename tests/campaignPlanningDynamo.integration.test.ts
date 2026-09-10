import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { awsRepository, partition, recordKey, UnknownCommitOutcome } from "@/lib/dynamo";
import { insertStrategyProposal, decideStrategyProposal } from "@/lib/strategy/repository";
import { strategyDigest } from "@/lib/strategyApproval";
import { strategyFixture } from "./fixtures/strategy";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { getJob, markFailed, retryFailedJobWithOutbox } from "@/lib/repository";
import { artifactProductionSubmissionSchema } from "@/lib/contentArtifacts/submission";
import { editorialPlanSchema } from "@/lib/contracts";
import { createArtifactStore } from "@/lib/artifactStore";
import { sourceAnalysisDigest } from "@/lib/sourceAnalysis";
import { loadWorkspaceContentContext } from "@/lib/workspaceContentContext";

const tenant = (): TenantContext => ({ workspaceId: `campaign-${randomUUID()}`, brandId: "a", principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } });
async function setup() {
  const strategy = strategyFixture("direction"); const digest = strategyDigest(strategy);
  const proposal = await awsRepository().atomic(tx => insertStrategyProposal(tx, { jobId: "strategy-origin", attempt: 1, strategy, digest, evidenceLineage: ["m1"], invocationContext: { revision: 1, sourceIds: ["m1"], operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
  const result = await awsRepository().atomic(tx => decideStrategyProposal(tx, proposal.id, { decision: "approved", payloadDigest: digest, expectedActiveRevision: 0 }));
  const repo = await import("@/lib/campaigns/repository");
  await repo.configurePlanningPolicy({ timezone: "America/New_York", productionCapacity: { maxItems: 24, maxItemsPerWeek: 6 }, cadenceConstraints: { minimumHoursBetweenItems: 24, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
  return result.strategyRef!;
}
async function request(disposition: "independent" | "new_initiative" = "new_initiative") {
  return submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Write a creative X post inviting founders to imagine a better workflow; no factual claims.", advice: { action: "create_job", disposition, expectedOutcome: "Invite founders", requestedOutputs: ["x_post"], sourceHandles: [], targetName: "Launch" } });
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("persistent campaign calendar", () => {
  it("audits calendar and advance chat commands with exact replay and no duplicate dispatch", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const command = { action: "manage_calendar" as const, targetName: base.itemRefs[0].id, requestId: randomUUID(), message: "Schedule for 2026-09-01T12:00:00Z" };
    const changed = await api.executePlanningChat(command);
    expect(changed.outcome).toBe("applied"); expect(await api.executePlanningChat(command)).toEqual(changed);
    expect((await repo.currentPlan(base.planRef.id)).ref.revision).toBe(2);
    const advance = { action: "advance_plan" as const, targetName: base.planRef.id, requestId: randomUUID(), message: "Advance this plan" };
    const claimed = await api.executePlanningChat(advance); expect(claimed.claim?.jobId).toBeTruthy();
    expect(await api.executePlanningChat(advance)).toEqual(claimed);
    await expect(api.executePlanningChat({ ...advance, message: "Changed request" })).rejects.toThrow("identity reused");
    const receipts = await awsRepository().query(partition(`${repo.campaignRoot()}/planning_chat_receipts`));
    expect(receipts.rows).toHaveLength(2);
  }));
  it("exposes failed dependencies and retries the same execution binding across recovery", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository"); const selection = await import("@/lib/planning/selection");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const second = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Dependent work", operatorBrief: "Imagine a follow-up", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-03T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: [] });
    const claim = await selection.claimNextPlannedItem(base.planRef.id);
    await markFailed({ jobId: claim!.jobId, stage: "draft", category: "dependency", code: "managed_dependency_unavailable", publicMessage: "Temporarily unavailable", retryable: true, operationId: `job:${claim!.jobId}:stage:draft:generation:0`, traceId: "a".repeat(32), attempt: 1, maxAttempts: 3, details: {} });
    expect(await repo.readItemState(base.itemRefs[0])).toMatchObject({ status: "failed", retryable: true });
    expect(await selection.claimNextPlannedItem(base.planRef.id)).toBeNull();
    expect((await repo.readItemState(second.itemRef)).reason).toContain("failed");
    const retryOutbox = await retryFailedJobWithOutbox(claim!.jobId, "draft");
    await selection.recoverPlannedWork();
    expect(await selection.claimNextPlannedItem(base.planRef.id)).toMatchObject({ jobId: claim!.jobId, outboxId: retryOutbox });
    expect((await repo.readItemState(base.itemRefs[0])).jobId).toBe(claim!.jobId);
  }));
  it("rechecks changed capacity before a claim and stages supplied source replacements", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    await repo.configurePlanningPolicy({ timezone: "America/New_York", productionCapacity: { maxItems: 24, maxItemsPerWeek: 6 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 1);
    const one = await request(); const first = await api.materializeIntake({ draftId: one.id, expectedDraftRevision: 1, requestId: one.answers.at(-1)!.requestId });
    const two = await request(); await api.materializeIntake({ draftId: two.id, expectedDraftRevision: 1, requestId: two.answers.at(-1)!.requestId });
    await repo.configurePlanningPolicy({ timezone: "America/New_York", productionCapacity: { maxItems: 24, maxItemsPerWeek: 1 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 2);
    const selection = await import("@/lib/planning/selection");
    expect(await selection.claimNextPlannedItem(first.planRef.id)).toBeNull();
    const replacement = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Use this new source in the planned item", advice: { action: "create_job", disposition: "existing_plan_item", targetName: first.itemRefs[0].id, expectedOutcome: "Replace sources", requestedOutputs: ["x_post"], sourceHandles: [{ kind: "web", url: "https://example.com/new" }] } });
    expect(replacement.state).toBe("ready_for_planning");
    const staged = await api.materializeIntake({ draftId: replacement.id, expectedDraftRevision: 1, requestId: replacement.answers.at(-1)!.requestId });
    expect(staged.proposalId).toBeTruthy();
    expect((await repo.readItemState(first.itemRefs[0])).status).toBe("requires_disposition");
    expect((await repo.readPlannedItem(first.itemRefs[0])).evidence.mode).toBe("operator_context");
  }));
  it("reconciles committed intake/claim responses and leaves uncommitted intake retryable", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const selection = await import("@/lib/planning/selection");
    const draft = await request(); const input = { draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId };
    const store = awsRepository(); const actual = store.atomic.bind(store);
    let fault = vi.spyOn(store, "atomic").mockImplementationOnce(async () => { throw new UnknownCommitOutcome(new Error("connection interrupted before commit")); });
    await expect(api.materializeIntake(input)).rejects.toThrow("unknown"); fault.mockRestore();
    fault = vi.spyOn(store, "atomic").mockImplementationOnce(async work => { await actual(work); throw new UnknownCommitOutcome(new Error("committed response lost")); });
    const materialized = await api.materializeIntake(input); fault.mockRestore();
    expect(await api.materializeIntake(input)).toEqual(materialized);
    fault = vi.spyOn(store, "atomic").mockImplementationOnce(async work => { await actual(work); throw new UnknownCommitOutcome(new Error("claim response lost")); });
    const claim = await selection.claimNextPlannedItem(materialized.planRef.id); fault.mockRestore();
    expect((await selection.claimNextPlannedItem(materialized.planRef.id))?.jobId).toBe(claim!.jobId);
  }));
  it("uses real versioned S3 artifact authority for asset readiness", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    const draft = await request(); await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const artifact = await createArtifactStore(awsRepository()).create({ jobId: "authorized-source", operationId: "asset-upload", bytes: Buffer.from("Authorized design notes"), contentType: "text/plain", trust: "operator", producer: { kind: "operator", id: "operator", version: "1" }, retentionClass: "audit" });
    const assets = await repo.listPlanningAssets();
    expect(assets).toContainEqual(expect.objectContaining({ id: artifact.id, status: "ready" }));
  }));
  it("exposes cancelled dependencies and missing assets, preserves approved work as a proposal", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const second = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Follow-up", operatorBrief: "Imagine the next step", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-01T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: ["design"] });
    await awsRepository().patch(repo.authorityKey("planned_item_states", base.itemRefs[0]), { status: "cancelled" });
    const selection = await import("@/lib/planning/selection");
    expect(await selection.claimNextPlannedItem(base.planRef.id)).toBeNull();
    expect(await repo.readItemState(second.itemRef)).toMatchObject({ status: "blocked", reason: expect.stringContaining("cancelled") });
    expect((await repo.readItemState(second.itemRef)).reason).toContain("asset design");
    await awsRepository().patch(repo.authorityKey("planned_item_states", second.itemRef), { approvedDigest: "a".repeat(64), status: "awaiting_approval" });
    const change = await api.replanItem({ itemRef: second.itemRef, scheduledFor: "2026-09-07T12:00:00Z", requestId: randomUUID() });
    expect(change.outcome).toBe("proposal"); expect(change.reasons).toContain("changed approved work requires disposition");
    expect((await repo.readPlannedItem(second.itemRef)).scheduledFor).toBe("2026-09-01T12:00:00.000Z");
    const proposed = await api.executePlanningChat({ action: "manage_calendar", requestId: randomUUID(), message: "Change cadence" });
    expect(proposed.outcome).toBe("proposal"); expect(proposed.reply).toContain("Saved planning proposal");
  }));
  it("keeps campaign history immutable with CAS and advances distinct items after completion", async () => runWithTenant(tenant(), async () => {
    const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    expect(api).toHaveProperty("addPlannedDeliverable");
    const strategyRef = await setup(); const draft = await request(); const result = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const original = await repo.readCampaign(result.campaignRef!);
    const revision = await repo.createCampaign({ id: original.ref.id, name: "Revised launch", objective: original.objective, strategyRef }, 1);
    expect(revision.ref.revision).toBe(2); expect((await repo.readCampaign(original.ref)).name).toBe("Launch");
    await expect(repo.createCampaign({ id: original.ref.id, name: "Stale", objective: original.objective, strategyRef }, 1)).rejects.toThrow("stale");
    const second = await api.addPlannedDeliverable({ planId: result.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second deliverable", operatorBrief: "Imagine the next chapter", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-03T12:00:00Z", dependencies: result.itemRefs, requiredAssetIds: [] });
    const selection = await import("@/lib/planning/selection");
    const firstClaim = await selection.claimNextPlannedItem(result.planRef.id, "2099-01-01T00:00:00Z");
    expect(firstClaim?.itemRef).toEqual(result.itemRefs[0]);
    await awsRepository().patch(recordKey(`workspaces/${firstClaim!.itemRef.workspaceId}/jobs/${firstClaim!.jobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
    await selection.reconcilePlannedExecution(firstClaim!.jobId);
    const next = await repo.readItemState(second.itemRef);
    expect(next.jobId).toBeTruthy(); expect(next.jobId).not.toBe(firstClaim!.jobId);
    expect((await repo.readItemState(result.itemRefs[0])).status).toBe("completed");
    await expect(api.replanItem({ itemRef: result.itemRefs[0], scheduledFor: "2026-09-20T10:00:00Z", requestId: randomUUID() })).rejects.toThrow("completed");
    expect((await repo.currentPlan(result.planRef.id)).itemRefs).toContainEqual(result.itemRefs[0]);
  }));
  it("materializes a new initiative once with exact strategy, real campaign and explicit plan/item refs", async () => runWithTenant(tenant(), async () => {
    const api = await import("@/lib/planning/commands").catch(() => null);
    expect(api, "materialization commands must exist").not.toBeNull();
    const strategy = await setup(); const draft = await request();
    const input = { draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId };
    const [a, b] = await Promise.all([api!.materializeIntake(input), api!.materializeIntake(input)]);
    expect(a).toEqual(b); expect(a.campaignRef?.id).not.toBe(a.planRef.id);
    expect((await loadWorkspaceContentContext()).planReady).toBe(true);
    const repo = await import("@/lib/campaigns/repository");
    const item = await repo.readPlannedItem(a.itemRefs[0]);
    expect(item.strategyRef).toEqual(strategy); expect(item.campaignRef).toEqual(a.campaignRef);
    expect(item.operatorBrief).toBe(draft.originalOperatorBrief); expect(item.requestedOutputs).toEqual(["x_post"]);
    await expect(api!.materializeIntake({ ...input, requestId: "different-message" })).rejects.toThrow("message");
  }));
  it("creates independent planned work without campaign membership and isolates brands", async () => {
    const scope = tenant(); await runWithTenant(scope, async () => {
      await setup(); const draft = await request("independent"); const api = await import("@/lib/planning/commands");
      const result = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
      expect(result.campaignRef).toBeNull();
      const repo = await import("@/lib/campaigns/repository");
      expect((await repo.readPlannedItem(result.itemRefs[0])).campaignRef).toBeNull();
      await expect(runWithTenant({ ...scope, brandId: "b" }, () => repo.readPlannedItem(result.itemRefs[0]))).rejects.toThrow();
    });
  });
  it("claims one item and job/outbox atomically and suppresses restart duplicates", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    const draft = await request(); const materialized = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const selection = await import("@/lib/planning/selection");
    const [a, b] = await Promise.all([selection.claimNextPlannedItem(materialized.planRef.id), selection.claimNextPlannedItem(materialized.planRef.id)]);
    expect(a?.jobId).toBeTruthy(); expect(b?.jobId).toBe(a?.jobId);
    expect((await selection.claimNextPlannedItem(materialized.planRef.id))?.jobId).toBe(a?.jobId);
    const item = await repo.readPlannedItem(materialized.itemRefs[0]);
    expect(item.evidence.mode).toBe("operator_context");
    const job = await awsRepository().read(recordKey(`workspaces/${item.workspaceId}/jobs/${a!.jobId}`));
    expect(job.value?.sourceAnalysis).toBeUndefined(); expect(job.value?.plannedItemRef).toEqual(materialized.itemRefs[0]);
    const runtime = await getJob(a!.jobId);
    await awsRepository().patch(job.key, { operatorPlanningContext: { ...runtime.operatorPlanningContext, operatorBrief: "Changed context", contextDigest: sourceAnalysisDigest("Changed context") } });
    await expect(getJob(a!.jobId)).rejects.toThrow("planned item context");
    await awsRepository().patch(job.key, { operatorPlanningContext: runtime.operatorPlanningContext });
    const python = JSON.parse(execFileSync(resolve("agent/.venv/bin/python"), ["-m", "tests.disjoint_strategy_workflow_fixture"], { cwd: resolve("agent"), input: JSON.stringify({ stage: "draft", source_free: true, job: runtime, snapshot: { snapshot: runtime.editorialPlanningSnapshot, digest: runtime.editorialPlanningSnapshotDigest } }), encoding: "utf8" }));
    expect(editorialPlanSchema.parse(runtime.editorialPlan).items[0].evidenceRefs).toEqual([]);
    const output = artifactProductionSubmissionSchema.parse(python.posts.at(-1).payload);
    expect(output.result.accepted.artifacts[0].sourceSegmentRefs).toEqual([]);
    expect(python.observed[0].input.sourceBinding).toEqual(runtime.editorialPlanningSnapshot!.sourceBinding);
    const outbox = await awsRepository().query(partition(`workspaces/${item.workspaceId}/stage_outbox`));
    expect(outbox.rows.filter(row => row.value?.jobId === a!.jobId)).toHaveLength(1);
  }));
});
