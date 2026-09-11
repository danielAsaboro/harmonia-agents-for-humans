import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runWithTenant, currentTenant, type TenantContext } from "@/lib/tenancy";
import { awsRepository, recordKey, partition } from "@/lib/dynamo";
import { strategyFixture } from "./fixtures/strategy";
import { strategyDigest } from "@/lib/strategyApproval";
import { insertStrategyProposal, decideStrategyProposal, readActiveStrategyRef } from "@/lib/strategy/repository";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { materializeIntake, listPlanningProposals, disposePlanningProposal, addPlannedDeliverable } from "@/lib/planning/commands";
import { configurePlanningPolicy, readPlannedItem, readItemState, currentPlan, campaignRoot } from "@/lib/campaigns/repository";
import { claimNextPlannedItem } from "@/lib/planning/selection";
import { getJob } from "@/lib/repository";
import { campaignWorkerBridge } from "./fixtures/campaignWorkerBridge";
import { buildStageMessage } from "@/lib/queue";
import type { StageOutboxRecord } from "@/lib/stageOutbox";

// Local identity adapter only; the route, approval command and storage are real.
vi.mock("@/lib/auth", () => ({ tenantHandler: (handler: unknown) => handler }));
const tenant = (): TenantContext => ({ workspaceId: `disposition-${randomUUID()}`, brandId: "a", principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } });
async function setup() {
  const strategy = strategyFixture("direction"); const digest = strategyDigest(strategy);
  const proposal = await awsRepository().atomic(tx => insertStrategyProposal(tx, { jobId: "origin", attempt: 1, strategy, digest, evidenceLineage: ["m1"], invocationContext: { revision: 1, sourceIds: ["m1"], operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
  await awsRepository().atomic(tx => decideStrategyProposal(tx, proposal.id, { decision: "approved", payloadDigest: digest, expectedActiveRevision: 0 }));
  await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 24, maxItemsPerWeek: 6 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
  const draft = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Imagine a better workflow", advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "Invite founders", requestedOutputs: ["x_post"], sourceHandles: [], targetName: "Launch" } });
  return materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
}
async function promote() {
  const api = await import("@/lib/learning/proposals"); const base = (await readActiveStrategyRef())!;
  const feedback = await api.recordOperatorFeedback({ requestId: randomUUID(), text: "Invite founders to discuss their workflow", sourceIds: [] });
  const proposal = await api.createStrategyChangeProposal({ requestId: randomUUID(), baseStrategyRef: base, changes: [{ type: "cta_guidance", value: ["Invite founders to discuss their workflow"] }], rationale: "Operator feedback", evidenceRefs: [{ id: feedback.id, digest: feedback.digest }], contradictionRefs: [] });
  await api.decideStrategyChange({ id: proposal.id, revision: proposal.revision, digest: proposal.digest, decision: "approved" });
}
async function sourceProposal(dependent = false) {
  const base = await setup();
  if (dependent) await addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Follow up", operatorBrief: "Imagine tomorrow", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2098-01-01T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: [] });
  const draft = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Use https://example.com/current for this invitation", advice: { action: "create_job", disposition: "existing_plan_item", targetName: "Invite founders", expectedOutcome: "Invite founders", requestedOutputs: ["x_post"], sourceHandles: [{ kind: "web", url: "https://example.com/current" }] } });
  const replacement = await materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
  return { base, replacement, draft };
}
async function review(id: string) {
  const { GET } = await import("@/app/api/planning/proposals/[id]/route");
  const response = await GET(new Request(`http://localhost/api/planning/proposals/${id}`), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200); return response.json();
}
async function decide(id: string, decision: string, expectedAuthorityDigest: string, requestId = randomUUID()) {
  const { POST } = await import("@/app/api/planning/proposals/[id]/route");
  const response = await POST(new Request(`http://localhost/api/planning/proposals/${id}`, { method: "POST", body: JSON.stringify({ decision, expectedAuthorityDigest, requestId }) }), { params: Promise.resolve({ id }) });
  if (!response.ok) throw new Error((await response.json()).error); return response;
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("operator planning dispositions", () => {
  it("promotes learning, obtains an exact queued-work approval, rebases immutable work and resumes execution", async () => runWithTenant(tenant(), async () => {
    const base = await setup(); const original = await readPlannedItem(base.itemRefs[0]); await promote();
    expect(await claimNextPlannedItem(base.planRef.id)).toBeNull();
    const proposal = (await listPlanningProposals()).find(p => p.type === "strategy_rebase");
    expect(proposal, "strategy promotion must expose an actionable queued-work proposal").toBeDefined();
    const data = await review(String(proposal!.id));
    await expect(decide(String(proposal!.id), "rebase_to_current_strategy", "0".repeat(64))).rejects.toThrow("authority mismatch");
    const requestId = randomUUID(); const response = await decide(String(proposal!.id), "rebase_to_current_strategy", data.dispositionAuthorityDigest, requestId);
    expect(response.status).toBe(200); const result = await response.json(); expect(result.outcome).toBe("rebased");
    expect(await (await decide(String(proposal!.id), "rebase_to_current_strategy", data.dispositionAuthorityDigest, requestId)).json()).toEqual(result);
    await expect(decide(String(proposal!.id), "cancel", data.dispositionAuthorityDigest, requestId)).rejects.toThrow("identity reused");
    const plan = await currentPlan(base.planRef.id); expect(plan.ref.revision).toBe(2);
    const item = await readPlannedItem(plan.itemRefs[0]); expect(item.ref.revision).toBe(2); expect(item.strategyRef).toEqual(await readActiveStrategyRef());
    expect(await readPlannedItem(original.ref)).toEqual(original);
    const claim = await claimNextPlannedItem(plan.ref.id); expect(claim?.itemRef).toEqual(item.ref); expect((await getJob(claim!.jobId)).strategyRef).toEqual(item.strategyRef);
    vi.stubEnv("INTERNAL_API_TOKEN", "disposition-local-worker-token"); vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1"); vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
    const bridge = await campaignWorkerBridge();
    try {
      for (const stage of ["draft", "publish", "verify", "learn", "complete"]) {
        const rows = await awsRepository().query(partition(`workspaces/${plan.workspaceId}/stage_outbox`));
        const record = rows.rows.find(row => row.value?.jobId === claim!.jobId && row.value.stage === stage)?.value as unknown as StageOutboxRecord | undefined;
        if (!record && stage === "complete") break;
        expect(record).toBeDefined(); const message = buildStageMessage(plan.ref, record!);
        const result = await bridge.run({ event: JSON.parse(message.data.toString()), carrier: message.attributes, transportId: randomUUID() });
        expect(result.result.failed, JSON.stringify(bridge.requests)).not.toBe(true);
      }
      const completed = await getJob(claim!.jobId); expect(completed.terminalOutcome).toBe("succeeded"); expect(completed.verifications?.some(v => v.verified)).toBe(true);
      expect((await readItemState(item.ref)).status).toBe("completed");
    } finally { await bridge.close(); }
  }), 30000);
  it("rejects stale promotion approvals and permits a current explicit terminal disposition", async () => runWithTenant(tenant(), async () => {
    const base = await setup(); await promote(); const proposal = (await listPlanningProposals()).find(p => p.type === "strategy_rebase")!;
    expect(proposal).toBeDefined(); const data = await review(String(proposal.id)); await promote();
    await expect(decide(String(proposal.id), "rebase_to_current_strategy", data.dispositionAuthorityDigest)).rejects.toThrow(/stale|changed|pending/);
    const current = (await listPlanningProposals()).filter(p => p.type === "strategy_rebase" && p.state === "pending_approval").at(-1)!;
    const currentData = await review(String(current.id)); await decide(String(current.id), "cancel", currentData.dispositionAuthorityDigest);
    expect((await readItemState(base.itemRefs[0])).status).toBe("cancelled"); expect(await claimNextPlannedItem(base.planRef.id)).toBeNull();
  }));
  it("fetches and accepts the exact source replacement into a new source-bound revision and ingestion job", async () => runWithTenant(tenant(), async () => {
    const { base, replacement } = await sourceProposal();
    const data = await review(replacement.proposalId!); expect(data.proposal.type).toBe("source_replacement");
    const requestId = randomUUID(); const response = await decide(replacement.proposalId!, "accept_source_replacement", data.dispositionAuthorityDigest, requestId);
    const result = await response.json(); expect(result.outcome).toBe("sources_replaced");
    const plan = await currentPlan(base.planRef.id); const revised = await readPlannedItem(plan.itemRefs[0]);
    expect(revised.ref.revision).toBe(2); expect(revised.productionContext.mode).toBe("source_intake");
    expect((await readPlannedItem(base.itemRefs[0])).evidence.mode).toBe("operator_context");
    expect(await (await decide(replacement.proposalId!, "accept_source_replacement", data.dispositionAuthorityDigest, requestId)).json()).toEqual(result);
    const claim = await runWithTenant({ ...currentTenant(), principal: { kind: "service", subjectId: "harmonia-worker", workspaceRole: "service", authenticationId: "local-scheduler" } }, () => claimNextPlannedItem(plan.ref.id)); const job = await getJob(claim!.jobId);
    expect(job.stage).toBe("collect_sources"); expect(job.config.sourceManifestId).toBeTruthy(); expect(job.plannedItemRef).toEqual(revised.ref);
    expect(job.createdByUserId).toBe("operator");
    await expect(decide(replacement.proposalId!, "reject", data.dispositionAuthorityDigest)).rejects.toThrow("pending");
  }));
  it("rejects changed source rights, cross-tenant access, and restores existing eligible work on rejection", async () => runWithTenant(tenant(), async () => {
    const { base, replacement, draft } = await sourceProposal(); const data = await review(replacement.proposalId!);
    const scope = currentTenant(); await runWithTenant({ ...scope, brandId: "b" }, async () => {
      const { GET } = await import("@/app/api/planning/proposals/[id]/route");
      expect((await GET(new Request("http://localhost"), { params: Promise.resolve({ id: replacement.proposalId! }) })).status).toBe(404);
      await expect(disposePlanningProposal({ proposalId: replacement.proposalId!, decision: "keep_existing_execution", expectedAuthorityDigest: data.dispositionAuthorityDigest, requestId: randomUUID() })).rejects.toThrow("pending");
    });
    await awsRepository().patch(recordKey(`${campaignRoot()}/source_rights/${Object.values(draft.sourceRights)[0]}`), { revokedAt: new Date().toISOString() });
    await expect(decide(replacement.proposalId!, "accept_source_replacement", data.dispositionAuthorityDigest)).rejects.toThrow("revoked");
    await decide(replacement.proposalId!, "reject", data.dispositionAuthorityDigest);
    expect((await readItemState(base.itemRefs[0])).status).toBe("planned"); expect((await currentPlan(base.planRef.id)).ref).toEqual(base.planRef);
    expect((await claimNextPlannedItem(base.planRef.id))?.itemRef).toEqual(base.itemRefs[0]);
  }));
  it("reviews and rebinds exact dependent revisions without replacing their own creative context", async () => runWithTenant(tenant(), async () => {
    const { base, replacement } = await sourceProposal(true); const data = await review(replacement.proposalId!);
    expect(data.proposal.guarded).toHaveLength(2);
    await decide(replacement.proposalId!, "accept_source_replacement", data.dispositionAuthorityDigest);
    const plan = await currentPlan(base.planRef.id); const items = await Promise.all(plan.itemRefs.map(ref => readPlannedItem(ref)));
    const replacementItem = items.find(item => item.ref.id === base.itemRefs[0].id)!;
    const dependent = items.find(item => item.ref.id !== base.itemRefs[0].id)!;
    expect(dependent.ref.revision).toBe(2); expect(dependent.dependencies).toEqual([replacementItem.ref]); expect(dependent.evidence.mode).toBe("operator_context");
  }));
  it("preserves a running item and its effect authority when rebasing other queued work", async () => runWithTenant(tenant(), async () => {
    const base = await setup();
    const second = await addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Later", operatorBrief: "Imagine tomorrow", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2098-01-01T12:00:00Z", dependencies: [], requiredAssetIds: [] });
    const claim = (await claimNextPlannedItem(base.planRef.id))!; const before = await readItemState(claim.itemRef);
    await promote(); const proposal = (await listPlanningProposals()).find(p => p.type === "strategy_rebase")!; const data = await review(String(proposal.id));
    expect(data.proposal.guarded.map((g: { itemRef: unknown }) => g.itemRef)).toEqual([second.itemRef]);
    await decide(String(proposal.id), "rebase_to_current_strategy", data.dispositionAuthorityDigest);
    expect(await readItemState(claim.itemRef)).toEqual(before); expect((await getJob(claim.jobId)).plannedItemRef).toEqual(claim.itemRef);
  }));
  it("returns a refreshable conflict when an operator reviews stale exact approval authority", async () => runWithTenant(tenant(), async () => {
    const { replacement } = await sourceProposal(); const { POST } = await import("@/app/api/planning/proposals/[id]/route");
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ decision: "accept_source_replacement", expectedAuthorityDigest: "0".repeat(64), requestId: randomUUID() }) }), { params: Promise.resolve({ id: replacement.proposalId! }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "planning_conflict", refreshRequired: true });
  }));
  it("rejects a stale source acceptance but still permits safe rejection after unrelated plan append", async () => runWithTenant(tenant(), async () => {
    const { base, replacement } = await sourceProposal(); const data = await review(replacement.proposalId!);
    await addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Unrelated work", operatorBrief: "Imagine tomorrow", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2098-01-01T12:00:00Z", dependencies: [], requiredAssetIds: [] });
    await expect(decide(replacement.proposalId!, "accept_source_replacement", data.dispositionAuthorityDigest)).rejects.toThrow("stale plan revision");
    await decide(replacement.proposalId!, "reject", data.dispositionAuthorityDigest);
    expect((await readItemState(base.itemRefs[0])).status).toBe("planned"); expect((await currentPlan(base.planRef.id)).ref.revision).toBe(2);
  }));
});
