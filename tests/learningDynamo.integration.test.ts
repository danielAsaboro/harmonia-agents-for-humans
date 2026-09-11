import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import { currentTenant, runWithTenant, type TenantContext } from "@/lib/tenancy";
import { insertStrategyProposal, decideStrategyProposal, readActiveStrategyRef, readStrategyRevision } from "@/lib/strategy/repository";
import { strategyDigest } from "@/lib/strategyApproval";
import { strategyFixture } from "./fixtures/strategy";
import { configurePlanningPolicy, readPlannedItem, readItemState, campaignRoot } from "@/lib/campaigns/repository";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { materializeIntake, addPlannedDeliverable } from "@/lib/planning/commands";
import { claimNextPlannedItem, reconcilePlannedExecution } from "@/lib/planning/selection";
import { pinMeasurement } from "@/lib/learning/contracts";

const tenant = (): TenantContext => ({ workspaceId: `learning-${randomUUID()}`, brandId: "a", principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } });
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  await awsRepository().put(recordKey(`workspaces/${currentTenant().workspaceId}`), { id: currentTenant().workspaceId, budget: { estimatedUsd: "0.00", observedUsd: "0.00", reservedUsd: "0.00", limitUsd: "100.00", approvalThresholdUsd: "0.25" } });
  const strategy = strategyFixture("direction"), digest = strategyDigest(strategy);
  const proposal = await awsRepository().atomic(tx => insertStrategyProposal(tx, { jobId: "strategy-origin", attempt: 1, strategy, digest, evidenceLineage: [], invocationContext: { revision: 1, sourceIds: [], operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], searchEvidence: [], researchRequest: null, audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4 }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
  const result = await awsRepository().atomic(tx => decideStrategyProposal(tx, proposal.id, { decision: "approved", payloadDigest: digest, expectedActiveRevision: 0 }));
  await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 24, maxItemsPerWeek: 6 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 6 }, maxConcurrentItems: 1 }, 0);
  const draft = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Imagine a creative workflow", advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "Invite founders", requestedOutputs: ["x_post"], sourceHandles: [], targetName: "Launch" } });
  const plan = await materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
  return { ...plan, strategyRef: result.strategyRef! };
}
async function completed() {
  const base = await setup(); const claim = (await claimNextPlannedItem(base.planRef.id))!;
  const jobKey = recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${claim.jobId}`);
  await awsRepository().patch(jobKey, { stage: "complete", status: "complete", terminalOutcome: "succeeded", updatedAt: "2026-09-01T00:00:00Z" });
  await reconcilePlannedExecution(claim.jobId);
  return { ...base, claim, jobKey };
}
const manualDefinition = pinMeasurement({ id: "qualified", revision: 1, metricId: "business.qualified_replies", kind: "performance", unit: "count", comparator: "gte", target: 5, baseline: null, window: { anchor: "completion", startOffsetSeconds: 0, endOffsetSeconds: 0, collectionToleranceSeconds: 86400 }, collectionMethod: "operator" });
async function publishedCase() {
  vi.stubEnv("HARMONIA_X_METRICS_ENABLED", "true"); vi.stubEnv("X_METRICS_MAX_READ_COST_USD", "0.001000");
  const base = await setup(), claim = (await claimNextPlannedItem(base.planRef.id))!;
  const key = recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${claim.jobId}`);
  await awsRepository().patch(key, { stage: "complete", status: "complete", terminalOutcome: "succeeded", updatedAt: "2026-09-01T00:00:00Z", actions: [{ id: "action", type: "publish_x_post", state: "executed", payload: { text: "Authorized post" } }], verifications: [{ id: "verify", actionId: "action", receiptId: "receipt", target: "x:42", verified: true, method: "official_api_readback", checkedAt: "2026-09-01T00:00:00Z", evidence: { url: "https://x.com/i/web/status/42", digest: "a".repeat(64) } }] });
  await awsRepository().put(recordKey(`${key.path}/receipts/receipt`), { id: "receipt", jobId: claim.jobId, actionType: "publish_x_post", actionId: "action", outcome: "applied", performedAt: "2026-09-01T00:00:00Z" });
  await reconcilePlannedExecution(claim.jobId);
  const api = await import("@/lib/learning/repository"); const collection = (await api.scheduleCompletedJob(claim.jobId)).find(c => c.measurement.definition.collectionMethod === "official_x")!;
  return { ...base, key, claim, api, collection };
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("durable learning", () => {
  it.each(["confirmed_not_dispatched", "confirmed_dispatched_with_estimated_cost", "confirmed_provider_result", "still_unknown"])("reconciles unknown reads explicitly: %s", async outcome => runWithTenant(tenant(), async () => {
    const { api, collection, key } = await publishedCase(), token = "a".repeat(64);
    await api.claimObservation(collection.id, token, "2026-09-02T00:00:00Z");
    const permit = await api.authorizeObservationDispatch(collection.id, token, "2026-09-02T00:00:00Z");
    const originalInput = { collectionId: collection.id, token, checkedAt: "2026-09-02T00:00:10Z", metrics: null, outcome: "unknown" as const };
    await api.completeProviderObservation(originalInput, "2026-09-02T00:00:10Z");
    const receiptKey = api.learningKey("observation_collection_receipts", `${collection.id}:${token}`), original = (await awsRepository().read(receiptKey)).value!;
    const reconciliation = await import("@/lib/learning/reconciliation");
    const input = { collectionId: collection.id, token, dispatchDigest: strategyDigest(permit!.dispatch), originalReceiptDigest: strategyDigest(original), expectedReconciliationDigest: null, requestId: "resolve", outcome,
      evidence: { kind: outcome === "confirmed_provider_result" ? "provider_response" : "operator_attestation", reference: "provider-support-case:123", detail: "Operator inspected the provider request audit and attached this disposition", checkedAt: "2026-09-02T00:02:00Z" },
      providerResult: outcome === "confirmed_provider_result" ? { ...originalInput, outcome: "available", metrics: { likes: 7, replies: 1, reposts: 0, quotes: 0 } } : null };
    const scope = currentTenant();
    const route = await import("@/app/api/learning/reconciliation/route");
    expect((await route.POST(new Request("http://localhost/api/learning/reconciliation", { method: "POST", body: JSON.stringify(input) }))).status).toBe(401);
    for (const principal of [{ ...scope.principal, workspaceRole: "member" }, { kind: "service", subjectId: "harmonia-worker", workspaceRole: "service", authenticationId: "test" }]) await expect(runWithTenant({ ...scope, principal } as TenantContext, () => reconciliation.reconcileObservation(input))).rejects.toThrow("administrator");
    await expect(runWithTenant({ ...scope, brandId: "other" }, () => reconciliation.reconcileObservation(input))).rejects.toThrow();
    for (const change of [{ dispatchDigest: "b".repeat(64) }, { originalReceiptDigest: "b".repeat(64) }, { token: "b".repeat(64) }, { expectedReconciliationDigest: "b".repeat(64) }]) await expect(reconciliation.reconcileObservation({ ...input, ...change })).rejects.toThrow();
    const receipt = await reconciliation.reconcileObservation(input);
    expect(await reconciliation.reconcileObservation(input)).toEqual(receipt);
    await expect(reconciliation.reconcileObservation({ ...input, evidence: { ...input.evidence, detail: "Changed evidence" } })).rejects.toThrow("identity reused");
    expect((await awsRepository().read(receiptKey)).value).toEqual(original);
    expect(await api.completeProviderObservation(originalInput)).toMatchObject({ availability: "failed" });
    expect(await api.claimObservation(collection.id, "b".repeat(64), "2026-09-02T00:03:00Z")).toBeNull();
    const reserved = outcome === "still_unknown" ? "0.001" : "0.00";
    for (const row of [await awsRepository().read(key), await awsRepository().read(recordKey(`workspaces/${scope.workspaceId}`))]) expect(row.value?.budget).toMatchObject({ reservedUsd: reserved, observedUsd: "0.00" });
    const cost = (await awsRepository().read(api.learningKey("observation_cost_reservations", permit!.costAuthorization!.reservationId))).value;
    expect(cost).toMatchObject({ state: outcome === "still_unknown" ? "reserved" : outcome === "confirmed_not_dispatched" ? "released" : "settled", observedCostUsd: null });
    if (outcome === "confirmed_provider_result") expect(await api.readObservation(receipt.observationId)).toMatchObject({ availability: "available", value: 7 });
    if (outcome !== "still_unknown") await expect(reconciliation.reconcileObservation({ ...input, requestId: "conflict", outcome: "still_unknown", providerResult: null })).rejects.toThrow(/resolved|stale/);
    else {
      await expect(reconciliation.reconcileObservation({ ...input, requestId: "stale" })).rejects.toThrow("stale");
      await reconciliation.reconcileObservation({ ...input, requestId: "resolved-later", expectedReconciliationDigest: receipt.digest, outcome: "confirmed_not_dispatched" });
      expect((await awsRepository().read(key)).value?.budget).toMatchObject({ reservedUsd: "0.00" });
    }
  }));
  it("blocks unknown read reconciliation after publication evidence is withdrawn", async () => runWithTenant(tenant(), async () => {
    const { api, collection, key } = await publishedCase(), token = "a".repeat(64);
    await api.claimObservation(collection.id, token, "2026-09-02T00:00:00Z");
    await api.authorizeObservationDispatch(collection.id, token, "2026-09-02T00:00:00Z");
    await api.claimObservation(collection.id, "b".repeat(64), "2026-09-02T00:01:01Z");
    const r = await import("@/lib/learning/reconciliation"), pending = (await r.pendingObservationReconciliations())[0];
    expect(pending.originalReceipt.outcome).toBe("unknown");
    const input = { collectionId: pending.collectionId, token, dispatchDigest: pending.dispatchDigest, originalReceiptDigest: pending.originalReceiptDigest, expectedReconciliationDigest: null, requestId: "recover-expired", outcome: "confirmed_not_dispatched", evidence: { kind: "operator_attestation", reference: "request-audit:expired", detail: "Provider audit shows no dispatched request", checkedAt: "2026-09-02T00:02:00Z" }, providerResult: null };
    const old = (await awsRepository().read(key)).value!;
    const reservationKey = api.learningKey("observation_cost_reservations", `metrics-${collection.id}`), reservation = (await awsRepository().read(reservationKey)).value!;
    await awsRepository().patch(reservationKey, { state: "released" });
    await expect(r.reconcileObservation(input)).rejects.toThrow("reservation");
    await awsRepository().put(reservationKey, reservation);
    await awsRepository().patch(key, { verifications: [] });
    await expect(r.reconcileObservation(input)).rejects.toThrow(/publication|effect|verification/);
    await awsRepository().patch(key, { verifications: old.verifications });
    await api.revokeLearningObservations({ jobId: collection.jobId }, "Evidence withdrawn");
    await expect(r.reconcileObservation(input)).rejects.toThrow(/resolved|revoked/);
  }));
  it("does not grant rejected or advisory proposals performance authority", async () => runWithTenant(tenant(), async () => {
    const { strategyRef } = await setup(), p = await import("@/lib/learning/proposals"), api = await import("@/lib/learning/repository");
    const feedback = await p.recordOperatorFeedback({ requestId: "advice", text: "Try a clearer invitation", sourceIds: [] });
    const proposal = await p.createStrategyChangeProposal({ requestId: "advice", baseStrategyRef: strategyRef, changes: [{ type: "assumption", value: "Test a clearer invitation" }], rationale: "Operator suggestion", evidenceRefs: [{ id: feedback.id, digest: feedback.digest }], contradictionRefs: [] });
    const insights = await api.learningInsights();
    expect(insights.learningContext.performanceEvidenceRefs).toEqual([]);
    expect(insights.learningContext.advisoryEvidenceRefs.map(r => r.id)).toContain(proposal.id);
    const base = await readStrategyRevision(strategyRef), measured = structuredClone(base.strategy); measured.objectives[0].text = "Measured engagement improved"; measured.objectives[0].evidenceRefs = [proposal.id];
    await expect(awsRepository().atomic(tx => insertStrategyProposal(tx, { jobId: "invalid-measured-advice", attempt: 1, strategy: measured, digest: strategyDigest(measured), evidenceLineage: [proposal.id], invocationContext: { ...base.invocationContext, learningEvidence: insights.learningContext.advisoryEvidenceRefs }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }))).rejects.toThrow("performance claim");
    const script = `import json,sys
from harmonia_agent.learning_models import LearningContext
from harmonia_agent.agent_models import AnalystInput, StrategistInput
from harmonia_agent.agents import _materialize_nimi_analysis, validate_strategy_grounding
from tests.test_nimi_contracts import analyst_input, source_analysis
from tests.test_ryan_strategy import strategist_input, strategy
wire=json.load(sys.stdin); pid=wire['proposals'][0]['id']; rejected=wire['proposals'][0]['status']=='rejected'; c=LearningContext.model_validate(wire)
if rejected: assert c.proposals==[] and c.performanceEvidenceRefs==[]
n=analyst_input(); n['learningContext']=c.model_dump(); n['performanceObservations']=[]; a=source_analysis(); a['angles'][0].update(angleType='performance_learning', evidenceKind='performance', evidenceRefs=[pid], title='Measured engagement improved')
result=_materialize_nimi_analysis(AnalystInput.model_validate(n),a)
assert not any(x.evidenceKind=='performance' for x in result.angles)
r=strategist_input().model_dump(); r['learningContext']=c.model_dump(); r['performance']=[]; s=strategy(); s.objectives[0].text='Measured engagement improved'; s.objectives[0].evidenceRefs=[pid]
for item in [*s.pillars, *s.channelRoles]: item.evidenceRefs=[ref for ref in item.evidenceRefs if ref!='perf-1']
try: validate_strategy_grounding(StrategistInput.model_validate(r),s)
except Exception as error:
 assert ("unknown evidence references" if rejected else "performance claim") in str(error)
else: raise AssertionError('advisory proposal accepted as performance')
print('ok')`;
    expect(execFileSync(resolve("agent/.venv/bin/python"), ["-c", script], { cwd: resolve("agent"), input: JSON.stringify(insights.learningContext), encoding: "utf8" }).trim()).toBe("ok");
    const rejected = await p.decideStrategyChange({ id: proposal.id, revision: proposal.revision, digest: proposal.digest, decision: "rejected", feedback: "Not approved" });
    expect(execFileSync(resolve("agent/.venv/bin/python"), ["-c", script], { cwd: resolve("agent"), input: JSON.stringify({ ...insights.learningContext, proposals: [rejected], advisoryEvidenceRefs: [] }), encoding: "utf8" }).trim()).toBe("ok");
    expect((await api.learningInsights()).learningContext.advisoryEvidenceRefs).toEqual([]);
    await expect(p.validateLearningReference(proposal.id, proposal.digest)).rejects.toThrow(/rejected|ineligible/);
  }));
  it("preserves historical pending cohorts after arrival but detects replacement and revocation", async () => runWithTenant(tenant(), async () => {
    const { api, collection, planRef, key } = await publishedCase(), token = "a".repeat(64);
    await addPlannedDeliverable({ planId: planRef.id, expectedRevision: planRef.revision, requestId: "pending", name: "Second post", operatorBrief: "Imagine an invitation", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-01T00:00:00Z", dependencies: [], requiredAssetIds: [] });
    const claim = (await claimNextPlannedItem(planRef.id))!, secondKey = recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${claim.jobId}`), firstJob = (await awsRepository().read(key)).value!;
    await awsRepository().patch(secondKey, { stage: "complete", status: "complete", terminalOutcome: "succeeded", updatedAt: firstJob.updatedAt, actions: firstJob.actions, verifications: firstJob.verifications });
    await awsRepository().put(recordKey(`${secondKey.path}/receipts/receipt`), { id: "receipt", jobId: claim.jobId, actionType: "publish_x_post", actionId: "action", outcome: "applied", performedAt: "2026-09-01T00:00:00Z" });
    await reconcilePlannedExecution(claim.jobId);
    const second = (await api.scheduleCompletedJob(claim.jobId)).find(c => c.measurement.definition.collectionMethod === "official_x")!;
    const collect = async (id: string) => { await api.claimObservation(id, token, "2026-09-02T00:00:00Z"); await api.authorizeObservationDispatch(id, token, "2026-09-02T00:00:00Z"); await api.completeProviderObservation({ collectionId: id, token, checkedAt: "2026-09-02T00:00:10Z", metrics: { likes: 4, replies: 1, reposts: 0, quotes: 0 }, outcome: "available" }, "2026-09-02T00:00:10Z"); };
    await collect(collection.id);
    const p = await import("@/lib/learning/proposals"), before = await api.listLearningContext(), evaluation = before.evaluations.find(e => e.missingCounts.pending_window === 1)!;
    expect(evaluation.cohortMembers).toContainEqual(expect.objectContaining({ id: second.observationId, availability: "pending_window", window: second.window }));
    const proposal = before.proposals.find(p => p.evidenceRefs.some(r => r.id === evaluation.id))!;
    const decision = await p.decideStrategyChange({ id: proposal.id, revision: proposal.revision, digest: proposal.digest, decision: "approved" });
    await collect(second.id);
    await expect(readStrategyRevision(decision.approvedStrategyRef!)).resolves.toBeDefined();
    expect((await p.readLearningEvidence(evaluation.id)).evaluation).toEqual(evaluation);
    const historicalKey = api.learningKey("performance_observations", second.observationId), original = (await awsRepository().read(historicalKey)).value!, { digest: _digest, ...body } = original; void _digest;
    await awsRepository().put(historicalKey, { ...body, reason: "tampered", digest: strategyDigest({ ...body, reason: "tampered" }) });
    await expect(readStrategyRevision(decision.approvedStrategyRef!)).rejects.toThrow(/digest|head|lineage|cohort/);
    await awsRepository().put(historicalKey, original);
    const secondCollectionKey = api.learningKey("observation_outbox", second.id);
    await api.revokeLearningObservations({ jobId: claim.jobId }, "Withdraw collection evidence");
    const revokedCollection = await awsRepository().read(secondCollectionKey);
    expect(await api.readObservation(String(revokedCollection.value?.observationId))).toMatchObject({ availability: "revoked" });
    // The operational pointer is mutable state. It must not be able to roll an
    // approved strategy back to the earlier valid cohort member after revocation.
    await awsRepository().patch(secondCollectionKey, { observationId: second.observationId });
    await expect(readStrategyRevision(decision.approvedStrategyRef!)).rejects.toThrow(/head|lineage|revoked/);
    await p.revokeLearningEvidence(evaluation.id, "Withdraw underlying evidence");
    await expect(readStrategyRevision(decision.approvedStrategyRef!)).rejects.toThrow("revoked");
    expect((await p.listStrategyChangeProposals()).find(p => p.id === proposal.id)).toMatchObject({ status: "approved", evidenceStatus: "revoked" });
  }));
  it("pins operator measurements through the shipped command with exact revisions and protected-work disposition", async () => runWithTenant(tenant(), async () => {
    const base = await setup(), commands = await import("@/lib/planning/commands");
    const configure = (commands as unknown as { configurePlannedMeasurement: (input: unknown) => Promise<{ outcome: string; itemRef: typeof base.itemRefs[0]; proposalId?: string }> }).configurePlannedMeasurement;
    expect(configure).toBeTypeOf("function");
    const input = { itemRef: base.itemRefs[0], expectedPlanRef: base.planRef, strategyRef: base.strategyRef, measurement: manualDefinition.definition, requestId: "configure" };
    const route = await import("@/app/api/learning/route"); expect((await route.POST(new Request("http://localhost/api/learning", { method: "POST", body: JSON.stringify({ action: "configure_measurement", ...input }) }))).status).toBe(401);
    const scope = currentTenant();
    await expect(runWithTenant({ ...scope, principal: { kind: "service", subjectId: "service", authenticationId: "test" } } as unknown as TenantContext, () => configure(input))).rejects.toThrow();
    const result = await configure(input); expect(result.outcome).toBe("applied");
    expect(await configure(input)).toEqual(result);
    const next = await readPlannedItem(result.itemRef); expect(next.ref.revision).toBe(2); expect(next.measurements).toContainEqual(manualDefinition);
    expect((await readPlannedItem(base.itemRefs[0])).measurements).not.toContainEqual(manualDefinition);
    await expect(configure({ ...input, requestId: "stale" })).rejects.toThrow("stale");
    const chat = await import("@/lib/chatHandler"); let current = next;
    for (const surface of ["dashboard", "telegram"] as const) {
      const command = { itemRef: current.ref, expectedPlanRef: current.planRef, strategyRef: current.strategyRef, measurement: manualDefinition.definition };
      const response = await chat.handleChat(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ surface, conversationId: surface, requestId: `measurement-${surface}`, message: `/measurement ${JSON.stringify(command)}` }) }));
      expect(response.status, await response.clone().text()).toBe(200); expect((await response.json()).intent).toBe("configure_measurement");
      current = await readPlannedItem({ ...current.ref, revision: current.ref.revision + 1 });
    }
    await claimNextPlannedItem(base.planRef.id);
    const protectedResult = await configure({ ...input, itemRef: current.ref, expectedPlanRef: current.planRef, requestId: "protected" });
    expect(protectedResult.outcome).toBe("proposal"); expect(protectedResult.proposalId).toBeTruthy();
  }));
  it("serializes exact evaluation citations through Nimi and Ryan validators and strategy authority", async () => runWithTenant(tenant(), async () => {
    const { api, collection, strategyRef, key } = await publishedCase();
    await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    await api.authorizeObservationDispatch(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    await api.completeProviderObservation({ collectionId: collection.id, token: "a".repeat(64), checkedAt: "2026-09-02T00:00:10Z", metrics: { likes: 4, replies: 1, reposts: 0, quotes: 0 }, outcome: "available" }, "2026-09-02T00:00:10Z");
    const insights = await api.learningInsights(), context = insights.learningContext;
    const script = `import json,sys
from harmonia_agent.learning_models import LearningContext, learning_evidence_refs
from harmonia_agent.agent_models import AnalystInput, SourceAnalysis, StrategistInput
from harmonia_agent.agents import validate_source_analysis, validate_strategy_grounding, _materialize_nimi_analysis
from harmonia_agent.stages import _performance_observations_for_nimi
from tests.test_nimi_contracts import analyst_input, source_analysis
from tests.test_ryan_strategy import strategist_input, strategy
wire=json.load(sys.stdin); c=LearningContext.model_validate(wire['learningContext']); eid=c.evaluations[0].id
performance=_performance_observations_for_nimi(wire)
assert all(p.id in {ref.id for ref in c.performanceEvidenceRefs} for p in performance)
n=analyst_input(); n['learningContext']=c.model_dump(); a=source_analysis(); a['angles'][0].update(angleType='performance_learning', evidenceKind='performance', evidenceRefs=[eid], assumptions=['Descriptive only'], confidence='low')
n['performanceObservations']=[p.model_dump() for p in performance]
a=_materialize_nimi_analysis(AnalystInput.model_validate(n), a).model_dump(mode='json', exclude_none=True)
validate_source_analysis(AnalystInput.model_validate(n), SourceAnalysis.model_validate(a))
r=strategist_input().model_dump(); r['learningContext']=c.model_dump(); s=strategy(); s.objectives[0].evidenceRefs=[eid]
validate_strategy_grounding(StrategistInput.model_validate(r), s)
print(json.dumps({'refs': learning_evidence_refs(c), 'analysis': a}))`;
    const wire = JSON.parse(execFileSync(resolve("agent/.venv/bin/python"), ["-c", script], { cwd: resolve("agent"), input: JSON.stringify(insights), encoding: "utf8" })), refs = wire.refs;
    const jobs = await import("@/lib/repository");
    await jobs.saveAnalysis(collection.jobId, wire.analysis, strategyDigest(wire.analysis), null, [], null, refs);
    expect((await awsRepository().read(key)).value?.analysisLearningEvidence).toEqual(refs);
    const feedback = await (await import("@/lib/learning/proposals")).recordOperatorFeedback({ requestId: "analysis-advice", text: "Try another post", sourceIds: [] });
    await expect(jobs.saveAnalysis(collection.jobId, { ...wire.analysis, angles: [{ ...wire.analysis.angles[0], evidenceRefs: [feedback.id] }] }, "a".repeat(64), null, [], null, [{ id: feedback.id, digest: feedback.digest }])).rejects.toThrow("unknown authoritative");
    await expect(jobs.saveAnalysis(collection.jobId, { ...wire.analysis, angles: [{ ...wire.analysis.angles[0], evidenceRefs: ["evaluation-unknown"] }] }, "a".repeat(64), null, [], null, refs)).rejects.toThrow("unknown authoritative");
    const base = await readStrategyRevision(strategyRef), strategy = structuredClone(base.strategy); strategy.objectives[0].evidenceRefs = [context.evaluations[0].id];
    const exact = await awsRepository().atomic(tx => insertStrategyProposal(tx, { jobId: "learned-strategy", attempt: 1, strategy, digest: strategyDigest(strategy), evidenceLineage: [context.evaluations[0].id], invocationContext: { ...base.invocationContext, learningEvidence: refs }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
    expect(exact.invocationContext.learningEvidence).toEqual(refs);
    await (await import("@/lib/learning/proposals")).revokeLearningEvidence(context.evaluations[0].id, "Withdrawn");
    await expect(awsRepository().atomic(tx => decideStrategyProposal(tx, exact.id, { decision: "approved", payloadDigest: exact.digest, expectedActiveRevision: strategyRef.revision }))).rejects.toThrow("revoked");
  }));
  it("rejects unknown learning evidence at the shared strategy authority boundary", async () => runWithTenant(tenant(), async () => {
    const base = await setup(), revision = await readStrategyRevision(base.strategyRef);
    await expect(awsRepository().atomic(tx => insertStrategyProposal(tx, { jobId: "unknown-evidence", attempt: 1, strategy: revision.strategy, digest: revision.ref.digest, evidenceLineage: ["evaluation-unknown"], invocationContext: { ...revision.invocationContext, learningEvidence: [{ id: "evaluation-unknown", digest: "a".repeat(64) }] }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }))).rejects.toThrow(/not found|unknown/);
  }));
  it("recovers erased completed work without recreating job authority", async () => runWithTenant(tenant(), async () => {
    const base = await completed(), api = await import("@/lib/learning/repository");
    const { eraseJobData } = await import("@/lib/repository");
    await eraseJobData({ workspaceId: currentTenant().workspaceId, brandId: "a", jobId: base.claim.jobId } as Parameters<typeof eraseJobData>[0], "operator");
    await expect(api.recoverLearning()).resolves.toBeDefined();
    expect((await awsRepository().read(api.learningKey("learning_erasure_receipts", base.claim.jobId))).value).toMatchObject({ availability: "revoked", jobId: base.claim.jobId });
    expect((await awsRepository().read(base.jobKey)).present).toBe(false);
    expect((await api.listLearningObservations()).every(o => o.availability === "revoked")).toBe(true);
    const item = await addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: base.planRef.revision, requestId: "after-erasure", name: "Unrelated work", operatorBrief: "Imagine the next invitation", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-01T00:00:00Z", dependencies: [], requiredAssetIds: [] });
    vi.stubEnv("INTERNAL_API_TOKEN", "local-recovery-test-token"); vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1");
    const queue = await import("@/lib/queue"); const sent: string[] = [];
    const transport = vi.spyOn(queue, "publishStage").mockImplementation(async (_scope, record) => { sent.push(record.jobId); return `offline-queue-receipt-${record.id}`; });
    try {
      const response = await (await import("@/app/api/internal/stage-outbox/route")).POST(new Request("http://localhost/api/internal/stage-outbox", { method: "POST", headers: { authorization: "Bearer local-recovery-test-token", "x-workspace-id": currentTenant().workspaceId, "x-brand-id": "a" }, body: "{}" }));
      expect(response.status).toBe(200); const state = await readItemState(item.itemRef); expect(sent).toContain(state.jobId);
      expect((await awsRepository().read(base.jobKey)).present).toBe(false);
    } finally { transport.mockRestore(); }
  }));
  it("recovers after actual workspace erasure without restoring deleted authority", async () => runWithTenant(tenant(), async () => {
    await completed(); const workspaceId = currentTenant().workspaceId;
    const jobs = await import("@/lib/repository"), lifecycle = await import("@/lib/lifecycle");
    await jobs.eraseWorkspaceData(lifecycle.planWorkspaceDeletion(workspaceId, `DELETE ${workspaceId}`, "Local lifecycle acceptance"), "operator");
    await expect((await import("@/lib/learning/repository")).recoverLearning()).resolves.toEqual({ failures: [] });
    expect((await awsRepository().read(recordKey(`workspaces/${workspaceId}`))).present).toBe(false);
    expect((await awsRepository().read(recordKey(`workspace_deletion_tombstones/${workspaceId}`))).value).toMatchObject({ state: "erased", contentErased: true });
  }));
  it("preserves unavailable cohort members in the persisted evaluation", async () => runWithTenant(tenant(), async () => {
    const { api, collection, planRef } = await publishedCase();
    const missing = await addPlannedDeliverable({ planId: planRef.id, expectedRevision: planRef.revision, requestId: "unmeasured", name: "Export only", operatorBrief: "Imagine an invitation", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-01T00:00:00Z", dependencies: [], requiredAssetIds: [] });
    const claim = (await claimNextPlannedItem(planRef.id))!;
    await awsRepository().patch(recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${claim.jobId}`), { stage: "complete", status: "complete", terminalOutcome: "succeeded" }); await reconcilePlannedExecution(claim.jobId);
    expect((await readItemState(missing.itemRef)).status).toBe("completed");
    await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z"); await api.authorizeObservationDispatch(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    await api.completeProviderObservation({ collectionId: collection.id, token: "a".repeat(64), checkedAt: "2026-09-02T00:00:10Z", metrics: { likes: 4, replies: 1, reposts: 0, quotes: 0 }, outcome: "available" }, "2026-09-02T00:00:10Z");
    const evaluation = (await api.listLearningContext()).evaluations[0]; expect(evaluation).toMatchObject({ cohortCount: 2, sampleCount: 1, value: 4, missingCounts: { unavailable: 1 } }); expect(evaluation.observationIds).toHaveLength(2);
  }));
  it("keeps unmeasured evaluations visible without granting inference citation authority", async () => runWithTenant(tenant(), async () => {
    await completed(); const api = await import("@/lib/learning/repository"), p = await import("@/lib/learning/proposals");
    const evaluation = (await import("@/lib/learning/evaluation")).evaluateObservations((await api.listLearningObservations()).filter(o => o.kind === "performance"));
    const evidence = await p.recordEvaluation(evaluation);
    expect((await api.learningInsights()).learningContext.performanceEvidenceRefs.map(ref => ref.id)).not.toContain(evidence.id);
    await expect(p.validateLearningReference(evidence.id, evidence.digest)).rejects.toThrow("unmeasured");
  }));
  it.each(["missing_connection_before_dispatch", "expired_before_provider_dispatch"])("releases confirmed %s exactly once", async reason => runWithTenant(tenant(), async () => {
    const { api, collection, key } = await publishedCase();
    const claim = (await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z"))!;
    if (reason.startsWith("expired")) await api.authorizeObservationDispatch(collection.id, claim.token!, "2026-09-02T00:00:00Z");
    await api.cancelObservationDispatch(collection.id, claim.token!, reason, "2026-09-02T00:01:01Z");
    await api.cancelObservationDispatch(collection.id, claim.token!, reason, "2026-09-02T00:01:02Z");
    expect(await api.authorizeObservationDispatch(collection.id, claim.token!, "2026-09-02T00:01:02Z")).toBeNull();
    for (const row of [await awsRepository().read(key), await awsRepository().read(recordKey(`workspaces/${currentTenant().workspaceId}`))]) expect(row.value?.budget).toMatchObject({ reservedUsd: "0.00", observedUsd: "0.00" });
    expect((await awsRepository().read(api.learningKey("observation_cost_reservations", claim.costAuthorization!.reservationId))).value).toMatchObject({ state: "released", provenance: "confirmed_no_dispatch" });
  }));
  it("issues one fresh dispatch permit, releases undispatched leases, and settles provider estimates once", async () => runWithTenant(tenant(), async () => {
    const { api, collection, key } = await publishedCase();
    const claimed = await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    const dispatch = (api as unknown as { authorizeObservationDispatch: (id: string, token: string, now: string) => Promise<unknown> }).authorizeObservationDispatch;
    expect(dispatch).toBeTypeOf("function");
    const results = await Promise.allSettled([dispatch(collection.id, claimed!.token!, "2026-09-02T00:00:01Z"), dispatch(collection.id, claimed!.token!, "2026-09-02T00:00:01Z")]);
    expect(results.filter(r => r.status === "fulfilled" && r.value)).toHaveLength(1);
    const body = { collectionId: collection.id, token: claimed!.token!, checkedAt: "2026-09-02T00:00:02Z", metrics: null, outcome: "unavailable" as const };
    await api.completeProviderObservation(body, "2026-09-02T00:00:02Z");
    await api.completeProviderObservation(body, "2026-09-02T00:00:03Z");
    const job = await awsRepository().read(key), workspace = await awsRepository().read(recordKey(`workspaces/${currentTenant().workspaceId}`));
    for (const row of [job, workspace]) expect(row.value?.budget).toMatchObject({ reservedUsd: "0.00", observedUsd: "0.00", settledEstimatedUsd: "0.001" });
    const reservation = await awsRepository().read(api.learningKey("observation_cost_reservations", claimed!.costAuthorization!.reservationId));
    expect(reservation.value).toMatchObject({ state: "settled", provenance: "configured_upper_bound_estimate", observedCostUsd: null });
  }));
  it("releases a confirmed undispatched expired claim from job and workspace budgets", async () => runWithTenant(tenant(), async () => {
    const { api, collection, key } = await publishedCase();
    await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    await api.claimObservation(collection.id, "b".repeat(64), "2026-09-02T00:01:01Z");
    for (const row of [await awsRepository().read(key), await awsRepository().read(recordKey(`workspaces/${currentTenant().workspaceId}`))]) expect(row.value?.budget).toMatchObject({ reservedUsd: "0.00", observedUsd: "0.00" });
  }));
  it("recomputes the reviewable change digest before a strategy decision", async () => runWithTenant(tenant(), async () => {
    const base = await setup(), p = await import("@/lib/learning/proposals");
    const evidence = await p.recordOperatorFeedback({ requestId: "digest", text: "Keep the CTA specific", sourceIds: [] });
    const proposal = await p.createStrategyChangeProposal({ requestId: "digest", baseStrategyRef: base.strategyRef, changes: [{ type: "cta_guidance", value: ["Discuss the workflow"] }], rationale: "Operator feedback", evidenceRefs: [{ id: evidence.id, digest: evidence.digest }], contradictionRefs: [] });
    await awsRepository().patch(recordKey(`${campaignRoot()}/strategy_change_proposals/${proposal.id}`), { changes: [{ type: "cta_guidance", value: ["Unreviewed changed CTA"] }] });
    await expect(p.decideStrategyChange({ id: proposal.id, revision: 1, digest: proposal.digest, decision: "approved" })).rejects.toThrow("digest");
    expect(await readActiveStrategyRef()).toEqual(base.strategyRef);
  }));
  it("fences the shared workspace budget before an X read", async () => runWithTenant(tenant(), async () => {
    const { api, collection } = await publishedCase();
    await awsRepository().put(recordKey(`workspaces/${currentTenant().workspaceId}`), { budget: { estimatedUsd: "0.00", observedUsd: "0.00", reservedUsd: "0.00", limitUsd: "0.00", approvalThresholdUsd: "0.25" } });
    expect(await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z")).toBeNull();
    const current = await awsRepository().read(api.learningKey("observation_outbox", collection.id)); expect(await api.readObservation(String(current.value?.observationId))).toMatchObject({ availability: "unavailable", value: null, reason: "metrics_budget_exceeded" });
  }));
  it("revokes future inference through a new immutable observation while retaining the original receipt", async () => runWithTenant(tenant(), async () => {
    const { api, collection, claim } = await publishedCase();
    await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    await api.authorizeObservationDispatch(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    const original = await api.completeProviderObservation({ collectionId: collection.id, token: "a".repeat(64), checkedAt: "2026-09-02T00:00:10Z", metrics: { likes: 4, replies: 1, reposts: 0, quotes: 0 }, outcome: "available" }, "2026-09-02T00:00:10Z");
    expect(api).toHaveProperty("revokeLearningObservations");
    await api.revokeLearningObservations({ jobId: claim.jobId }, "Job evidence erased");
    expect(await api.readObservation(original.id)).toEqual(original);
    const context = await api.listLearningContext(); expect(context.observations.find(o => o.collectionId === collection.id)).toMatchObject({ availability: "revoked", value: null });
    expect(context.evaluations).toEqual([]); expect(context.proposals[0].evidenceStatus).toBe("revoked");
  }));
  it.each(["failed", "unknown", "unavailable"] as const)("persists provider %s as absent performance with durable failure evidence", async outcome => runWithTenant(tenant(), async () => {
    const { api, collection } = await publishedCase();
    await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    await api.authorizeObservationDispatch(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    const input = { collectionId: collection.id, token: "a".repeat(64), checkedAt: "2026-09-02T00:00:10Z", metrics: null, outcome, reason: "Provider could not return metrics" };
    const observation = await api.completeProviderObservation(input, "2026-09-02T00:00:10Z");
    expect(observation.value).toBeNull(); expect(observation.availability).toBe(outcome === "unknown" ? "failed" : outcome);
    expect(await api.completeProviderObservation(input, "2026-09-02T00:00:11Z")).toEqual(observation);
    expect(await api.claimObservation(collection.id, "b".repeat(64), "2026-09-02T00:01:10Z")).toBeNull();
    expect((await api.listLearningContext()).evaluations).toEqual([]);
    const row = await awsRepository().read(api.learningKey("observation_outbox", collection.id)); expect(row.value?.state).toBe(outcome === "unknown" ? "reconciliation_required" : "completed");
  }));
  it("reconciles an expired collector lease without another paid dispatch and misses late windows visibly", async () => runWithTenant(tenant(), async () => {
    const { api, collection } = await publishedCase();
    expect(await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z")).toBeTruthy();
    await api.authorizeObservationDispatch(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    expect(await api.claimObservation(collection.id, "b".repeat(64), "2026-09-02T00:00:01Z")).toBeNull();
    expect(await api.claimObservation(collection.id, "b".repeat(64), "2026-09-02T00:01:01Z")).toBeNull();
    const current = await awsRepository().read(api.learningKey("observation_outbox", collection.id));
    expect(current.value).toMatchObject({ state: "reconciliation_required", attempts: 1 });
    expect(await api.readObservation(String(current.value?.observationId))).toMatchObject({ availability: "failed", value: null });
  }));
  it("requires explicit X cost configuration before a scheduled read", async () => runWithTenant(tenant(), async () => {
    const { api, collection } = await publishedCase(); vi.stubEnv("HARMONIA_X_METRICS_ENABLED", "false");
    expect(await api.claimObservation(collection.id, "a".repeat(64), "2026-09-02T00:00:00Z")).toBeNull();
    const current = await awsRepository().read(api.learningKey("observation_outbox", collection.id));
    expect(await api.readObservation(String(current.value?.observationId))).toMatchObject({ availability: "unavailable", value: null, reason: "X_metrics_cost_authority_not_configured" });
  }));
  it("rejects stale-base decisions and revoked source/evidence while retaining historical proposals", async () => runWithTenant(tenant(), async () => {
    const p = await import("@/lib/learning/proposals"); const base = await setup();
    const sourceKey = recordKey(`${campaignRoot()}/sources/discovered`);
    await awsRepository().put(sourceKey, { workspaceId: base.strategyRef.workspaceId, brandId: base.strategyRef.brandId, id: "discovered", state: "ready", contentDigest: "a".repeat(64) });
    const evidence = await p.recordSourceDiscovery("discovered");
    const input = { requestId: "discovery-change", baseStrategyRef: base.strategyRef, changes: [{ type: "cadence_guidance" as const, value: "Twice weekly" }], rationale: "Source discovery warrants a cadence review", evidenceRefs: [{ id: evidence.id, digest: evidence.digest }], contradictionRefs: [] };
    const pending = await p.createStrategyChangeProposal(input);
    const { revokeSourceKnowledge } = await import("@/lib/sourceKnowledgeErasure"); await revokeSourceKnowledge("discovered");
    const saved = await awsRepository().read(recordKey(`${campaignRoot()}/strategy_change_proposals/${pending.id}`)); expect(saved.value?.evidenceStatus).toBe("revoked");
    await expect(p.decideStrategyChange({ id: pending.id, revision: 1, digest: pending.digest, decision: "approved" })).rejects.toThrow(/revoked|unavailable/);
    expect(await readActiveStrategyRef()).toEqual(base.strategyRef);
    const feedback = await p.recordOperatorFeedback({ requestId: "fresh", text: "Use a gentler CTA", sourceIds: [] });
    const a = await p.createStrategyChangeProposal({ ...input, requestId: "fresh-a", evidenceRefs: [{ id: feedback.id, digest: feedback.digest }] });
    const b = await p.createStrategyChangeProposal({ ...input, requestId: "fresh-b", evidenceRefs: [{ id: feedback.id, digest: feedback.digest }] });
    await p.decideStrategyChange({ id: a.id, revision: 1, digest: a.digest, decision: "approved" });
    await expect(p.decideStrategyChange({ id: b.id, revision: 1, digest: b.digest, decision: "approved" })).rejects.toThrow("stale");
    const further = await p.recordOperatorFeedback({ requestId: "further", text: "A new observation", sourceIds: [] });
    const dependent = await p.createStrategyChangeProposal({ ...input, requestId: "dependent", baseStrategyRef: (await readActiveStrategyRef())!, evidenceRefs: [{ id: further.id, digest: further.digest }] });
    expect((await p.listStrategyChangeProposals()).find(x => x.id === b.id)?.status).toBe("superseded");
    await p.revokeLearningEvidence(feedback.id, "Operator withdrew evidence");
    expect((await p.listStrategyChangeProposals()).find(x => x.id === a.id)).toMatchObject({ status: "approved", evidenceStatus: "revoked" });
    expect((await p.listStrategyChangeProposals()).find(x => x.id === dependent.id)?.evidenceStatus).toBe("revoked");
    const inference = (await (await import("@/lib/learning/repository")).learningInsights()).learningContext;
    const revoked = inference.proposals.find(x => x.id === dependent.id)!;
    expect(Object.keys(revoked).sort()).toEqual(["evidenceStatus", "id", "revision", "status"].sort());
    expect(JSON.stringify(inference)).not.toContain(dependent.rationale);
    const modelPayload = execFileSync(resolve("agent/.venv/bin/python"), ["-c", "import json,sys; from harmonia_agent.learning_models import LearningContext; from tests.test_ryan_strategy import strategist_input; from harmonia_agent.agent_models import StrategistInput; body=strategist_input().model_dump(); body['learningContext']=json.load(sys.stdin); print(StrategistInput.model_validate(body).model_dump_json())"], { cwd: resolve("agent"), input: JSON.stringify(inference), encoding: "utf8" });
    expect(modelPayload).not.toContain(dependent.rationale); expect(modelPayload).not.toContain('"changes"');
    await expect(p.createStrategyChangeProposal({ ...input, requestId: "inherited-revoked", baseStrategyRef: (await readActiveStrategyRef())!, evidenceRefs: [{ id: further.id, digest: further.digest }] })).rejects.toThrow("revoked");
    const scope = currentTenant();
    await expect(runWithTenant({ ...scope, brandId: "b" }, () => p.readLearningEvidence(feedback.id))).rejects.toThrow("not found");
    await expect(runWithTenant({ ...scope, brandId: "b" }, () => p.createStrategyChangeProposal({ ...input, requestId: "other-brand" }))).rejects.toThrow();
  }));
  it("recovers completed jobs into the durable observation outbox during the ordinary planning tick", async () => runWithTenant(tenant(), async () => {
    const base = await completed();
    const rows = await awsRepository().query(partition(`${campaignRoot()}/observation_outbox`));
    expect(rows.rows.map(r => r.value?.jobId)).toEqual([base.claim.jobId, base.claim.jobId]);
  }));
  it("pins definitions and recovers export-only completion without inventing performance", async () => runWithTenant(tenant(), async () => {
    const api = await import("@/lib/learning/repository").catch(() => null); expect(api, "durable collection repository required").not.toBeNull();
    const { claim, itemRefs } = await completed();
    const item = await readPlannedItem(itemRefs[0]); expect(item.measurements).toHaveLength(2);
    const first = await api!.scheduleCompletedJob(claim.jobId); const second = await api!.scheduleCompletedJob(claim.jobId);
    expect(second).toEqual(first); expect(first).toHaveLength(2);
    const observations = await api!.listLearningObservations();
    expect(observations).toHaveLength(2); expect(observations.every(o => o.value === null)).toBe(true);
    expect(observations.find(o => o.kind === "performance")).toMatchObject({ availability: "unavailable", reason: "no_verified_publication" });
    expect((await api!.listLearningContext()).evaluations).toEqual([]);
    expect((await readItemState(itemRefs[0])).status).toBe("completed");
  }));
  it("retains delayed X windows, ingests the verified Task 0 contract once and refuses stale claims", async () => runWithTenant(tenant(), async () => {
    vi.stubEnv("HARMONIA_X_METRICS_ENABLED", "true"); vi.stubEnv("X_METRICS_MAX_READ_COST_USD", "0.001000");
    const api = await import("@/lib/learning/repository").catch(() => null); expect(api).not.toBeNull();
    const base = await completed();
    const original = await readPlannedItem(base.itemRefs[0]);
    const text = "Authorized post", digest = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
    await awsRepository().patch(base.jobKey, { actions: [{ id: "post-action", type: "publish_x_post", state: "executed", payload: { text } }], verifications: [{ id: "verify", actionId: "post-action", receiptId: "receipt", target: "x:42", verified: true, method: "official_api_readback", checkedAt: "2026-09-01T00:00:00Z", evidence: { url: "https://x.com/i/web/status/42", digest } }], receipts: [{ id: "receipt", actionId: "post-action", performedAt: "2026-09-01T00:00:00Z" }] });
    await awsRepository().put(recordKey(`${base.jobKey.path}/receipts/receipt`), { id: "receipt", jobId: base.claim.jobId, actionType: "publish_x_post", actionId: "post-action", outcome: "applied", performedAt: "2026-09-01T00:00:00Z" });
    // New exact revision for this independently prepared provider case.
    const next = { ...original, ref: { ...original.ref, revision: 2 } };
    const r = await import("@/lib/campaigns/repository");
    await awsRepository().put(r.authorityKey("planned_item_revisions", next.ref), next);
    await awsRepository().put(r.authorityKey("planned_item_states", next.ref), { ref: next.ref, workspaceId: next.workspaceId, brandId: next.brandId, status: "completed", jobId: base.claim.jobId });
    await awsRepository().patch(base.jobKey, { plannedItemRef: next.ref });
    const collections = await api!.scheduleCompletedJob(base.claim.jobId, "2026-09-01T00:00:00Z");
    const x = collections.find(c => c.measurement.definition.collectionMethod === "official_x")!;
    expect((await api!.readObservation(x.observationId)).availability).toBe("pending_window");
    expect(await api!.claimObservation(x.id, "a".repeat(64), "2026-09-01T12:00:00Z")).toBeNull();
    const claimed = await api!.claimObservation(x.id, "a".repeat(64), "2026-09-02T00:00:00Z"); expect(claimed?.postId).toBe("42");
    expect(claimed?.costAuthorization).toMatchObject({ maximumUsd: "0.001000" });
    await api!.authorizeObservationDispatch(x.id, "a".repeat(64), "2026-09-02T00:00:00Z");
    const body = { collectionId: x.id, token: "a".repeat(64), checkedAt: "2026-09-02T00:00:00Z", metrics: { likes: 3, replies: 0, reposts: 1, quotes: 0 }, outcome: "available" as const };
    const observation = await api!.completeProviderObservation(body, "2026-09-02T00:00:00Z");
    expect(observation).toMatchObject({ value: 3, availability: "available", postId: "42", actionId: "post-action", strategyRef: base.strategyRef });
    expect(await (await import("@/lib/repository")).listRecentEngagement()).toContainEqual(expect.objectContaining({ postId: "42", metrics: expect.objectContaining({ likes: 3 }) }));
    expect(await api!.completeProviderObservation(body, "2026-09-02T00:00:01Z")).toEqual(observation);
    await expect(api!.completeProviderObservation({ ...body, metrics: { ...body.metrics, likes: 900 } }, "2026-09-02T00:00:01Z")).rejects.toThrow("identity");
  }));
  it("attributes operator observations, persists reviewable proposals and promotes exact revisions through Task 1", async () => runWithTenant(tenant(), async () => {
    const api = await import("@/lib/learning/repository").catch(() => null); const proposals = await import("@/lib/learning/proposals").catch(() => null); expect(api).not.toBeNull(); expect(proposals).not.toBeNull();
    const base = await setup();
    const item = await addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Measure reply quality", operatorBrief: "Creative invitation", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-01T00:00:00Z", dependencies: [], requiredAssetIds: [], measurements: [manualDefinition] });
    const claim = (await claimNextPlannedItem(base.planRef.id))!;
    await awsRepository().patch(recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${claim.jobId}`), { stage: "complete", status: "complete", terminalOutcome: "succeeded" }); await reconcilePlannedExecution(claim.jobId);
    const state = await readItemState(item.itemRef);
    await awsRepository().patch(recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${state.jobId}`), { stage: "complete", status: "complete", terminalOutcome: "succeeded" }); await reconcilePlannedExecution(state.jobId!);
    const collection = (await api!.scheduleCompletedJob(state.jobId!))[0];
    const observation = await api!.recordOperatorObservation({ collectionId: collection.id, requestId: "observed", value: 7, evidenceText: "I counted seven qualified replies in the support inbox." });
    expect(observation).toMatchObject({ provider: "operator", actor: "operator", value: 7 });
    const context = await api!.listLearningContext(); expect(context.evaluations[0]).toMatchObject({ sampleCount: 1, causalClaim: false, confidence: "low" });
    const pending = (await proposals!.listStrategyChangeProposals())[0]; expect(pending).toMatchObject({ status: "pending", evidenceStatus: "valid", baseStrategyRef: base.strategyRef });
    expect(await readActiveStrategyRef()).toEqual(base.strategyRef);
    const rejected = await proposals!.decideStrategyChange({ id: pending.id, revision: pending.revision, digest: pending.digest, decision: "rejected", feedback: "Need a larger sample" }); expect(rejected.status).toBe("rejected"); expect(await readActiveStrategyRef()).toEqual(base.strategyRef);
    const feedback = await proposals!.recordOperatorFeedback({ requestId: "feedback", text: "Use an invitation CTA", sourceIds: [] });
    const next = await proposals!.createStrategyChangeProposal({ requestId: "cta", baseStrategyRef: base.strategyRef, changes: [{ type: "cta_guidance", value: ["Invite founders to discuss their workflow"] }], rationale: "Operator feedback", evidenceRefs: [{ id: feedback.id, digest: feedback.digest }], contradictionRefs: [] });
    const approved = await proposals!.decideStrategyChange({ id: next.id, revision: next.revision, digest: next.digest, decision: "approved" });
    const active = await readActiveStrategyRef(); expect(active?.revision).toBe(base.strategyRef.revision + 1); expect(active?.digest).toBe(next.proposedStrategyDigest); expect((await readStrategyRevision(active!)).strategy.ctaGuidance).toEqual(["Invite founders to discuss their workflow"]); expect(approved.approvedStrategyRef).toEqual(active);
    expect((await awsRepository().query(partition(`${campaignRoot()}/performance_observations`))).rows.length).toBeGreaterThan(1);
  }));
});
