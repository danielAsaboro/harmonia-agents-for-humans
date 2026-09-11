import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { currentTenant, runWithTenant, tenantCollectionPath, type TenantContext } from "@/lib/tenancy";
import { awsRepository, partition, recordKey, REMOVE_FIELD, UnknownCommitOutcome } from "@/lib/dynamo";
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
import { campaignWorkerBridge } from "./fixtures/campaignWorkerBridge";
import { buildStageMessage } from "@/lib/queue";
import type { StageOutboxRecord } from "@/lib/stageOutbox";
import { learningInferenceContextSchema } from "@/lib/learning/contracts";
import { compileProductionOperations, productionPlanDigest } from "@/lib/mediaProduction";
import { planRequestedMediaProduction } from "@/lib/outputMediaProduction";

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
async function permanentRetryPair() {
  await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository"); const selection = await import("@/lib/planning/selection");
  const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
  await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second", operatorBrief: "Imagine a follow-up", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2098-09-03T12:00:00Z", dependencies: [], requiredAssetIds: [] });
  const claim = (await selection.claimNextPlannedItem(base.planRef.id))!;
  await markFailed({ jobId: claim.jobId, stage: "draft", category: "validation", code: "fixed_contract", publicMessage: "Contract rejected", retryable: false, operationId: `job:${claim.jobId}:stage:draft:generation:0`, traceId: "a".repeat(32), attempt: 1, maxAttempts: 3, details: {} });
  const other = (await selection.claimNextPlannedItem(base.planRef.id, "2099-01-01T00:00:00Z"))!;
  const job = await getJob(claim.jobId);
  return { base, claim, other, repo, selection, job, input: { requestId: randomUUID(), afterFix: true as const, reason: "Deployed the draft contract correction", expectedGeneration: job.controlEpoch, expectedFailure: job.failure! } };
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("persistent campaign calendar", () => {
  it("carries later clarification subject, colors, and outcome into the exact media proposal while preserving the first brief", async () => runWithTenant(tenant(), async () => {
    await setup();
    const conversationId = randomUUID();
    const initialTurnId = randomUUID();
    const subjectTurnId = randomUUID();
    const outcomeTurnId = randomUUID();
    const initial = await submitIntakeTurn({
      requestId: initialTurnId, conversationId, surface: "dashboard", message: "Create a launch image, video, and instrumental soundtrack.",
      advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "", requestedOutputs: ["social_image", "generated_video", "generated_music"], sourceHandles: [], targetName: "Launch media", clarification: { field: "expectedOutcome", question: "What subject, colors, and outcome should the launch media use?" } },
    });
    expect(initial.state).toBe("clarifying");
    const withCreative = await submitIntakeTurn({
      requestId: subjectTurnId, conversationId, surface: "dashboard", message: "Feature a copper robot on a midnight-blue background with amber highlights.",
      advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "", requestedOutputs: ["social_image", "generated_video", "generated_music"], sourceHandles: [], targetName: "Launch media", clarification: { field: "expectedOutcome", question: "What measurable outcome should this media drive?" } },
    });
    expect(withCreative.state).toBe("clarifying");
    const completed = await submitIntakeTurn({
      requestId: outcomeTurnId, conversationId, surface: "dashboard", message: "Drive qualified founders to join the waitlist.",
      advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "Drive qualified founders to join the waitlist", requestedOutputs: ["social_image", "generated_video", "generated_music"], sourceHandles: [], targetName: "Launch media", resolvedField: "expectedOutcome", clarification: null },
    });
    expect(completed.originalOperatorBrief).toBe("Create a launch image, video, and instrumental soundtrack.");
    const materialized = await (await import("@/lib/planning/commands")).materializeIntake({ draftId: completed.id, expectedDraftRevision: completed.revision, requestId: outcomeTurnId });
    const item = await (await import("@/lib/campaigns/repository")).readPlannedItem(materialized.itemRefs[0]);
    expect(item.instructionContext).toMatchObject({
      originalOperatorBrief: completed.originalOperatorBrief,
      answerTurnIds: [subjectTurnId, outcomeTurnId],
    });
    expect(item.operatorBrief).toContain("copper robot on a midnight-blue background with amber highlights");
    expect(item.operatorBrief).toContain("Drive qualified founders to join the waitlist");
    const claim = await (await import("@/lib/planning/selection")).claimNextPlannedItem(materialized.planRef.id);
    const job = await getJob(claim!.jobId);
    expect(job.config.originalOperatorBrief).toBe(completed.originalOperatorBrief);
    expect(job.config.instructionContext).toEqual(item.instructionContext);
    const plan = planRequestedMediaProduction({ job, outputPlan: job.campaignOutputPlan!, pricing: { version: "test", canvasPerImage: "0.500000", reelPerSecond: "0.080000", musicPerSecond: "0.004000" } })!;
    const paid = compileProductionOperations(plan).filter(operation => operation.executionAuthority === "production_mandate");
    expect(paid.map(operation => operation.type).sort()).toEqual(["generate_image", "generate_music", "generate_video"]);
    for (const operation of paid) expect(operation.payload).toMatchObject({ instructionContext: item.instructionContext });
    expect(plan.outputRequest?.promptDigest).toBeTruthy();
    expect(productionPlanDigest(plan)).toMatch(/^[a-f0-9]{64}$/);
  }));
  it("completes two replanned dependent deliverables through the actual worker and TS API with real S3 exports", async () => runWithTenant(tenant(), async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "task3-local-worker-token"); vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1"); vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
    const bridge = await campaignWorkerBridge();
    try {
      await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository"); const selection = await import("@/lib/planning/selection");
      const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
      const appended = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second invitation", operatorBrief: "Imagine a different creative workflow; no factual claims", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-03T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: [] });
      await api.configurePlannedMeasurement({ itemRef: appended.itemRef, expectedPlanRef: appended.planRef, strategyRef: (await repo.readPlannedItem(appended.itemRef)).strategyRef, requestId: "configure-campaign-review", measurement: { id: "operator_quality", revision: 1, metricId: "operator.review_score", kind: "performance", unit: "count", comparator: "gte", target: 4, baseline: null, window: { anchor: "completion", startOffsetSeconds: 0, endOffsetSeconds: 0, collectionToleranceSeconds: 86400 }, collectionMethod: "operator" } });
      const revised = await api.replanItem({ itemRef: base.itemRefs[0], scheduledFor: "2026-09-01T12:00:00Z", requestId: randomUUID() });
      expect(revised.outcome).toBe("applied");
      const plan = await repo.currentPlan(base.planRef.id);
      expect((await repo.readPlannedItem(plan.itemRefs.find(ref => ref.id === appended.itemRef.id)!)).dependencies).toEqual([revised.itemRef]);
      await selection.claimNextPlannedItem(plan.ref.id);
      const jobIds = []; const producedTexts: string[] = [];
      for (const itemRef of plan.itemRefs) {
        const state = await repo.readItemState(itemRef); expect(state.status).toBe("running"); expect(state.jobId).toBeTruthy(); jobIds.push(state.jobId!);
        for (const [stage, next] of [["draft", "publish"], ["publish", "verify"], ["verify", "learn"], ["learn", "complete"]]) {
          const rows = await awsRepository().query(partition(`workspaces/${plan.ref.workspaceId}/stage_outbox`));
          const record = rows.rows.find(row => row.value?.jobId === state.jobId && row.value?.stage === stage)!.value as unknown as StageOutboxRecord;
          const message = buildStageMessage(plan.ref, record); const event = JSON.parse(message.data.toString());
          const input = { event, carrier: message.attributes, transportId: randomUUID() };
          const outcome = await bridge.run(input);
          expect(outcome, JSON.stringify(bridge.requests.filter(request => request.status >= 400))).toMatchObject({ acknowledged: true, result: { ack: true } });
          expect(outcome.result.failed, JSON.stringify(bridge.requests)).not.toBe(true);
          expect((await getJob(state.jobId!)).stage).toBe(next);
          if (itemRef.id === plan.itemRefs[0].id && next !== "complete") expect((await repo.readItemState(plan.itemRefs[1])).jobId).toBeUndefined();
          const replay = await bridge.run({ ...input, transportId: randomUUID(), deliveryAttempt: 2 });
          expect(replay.result.duplicate).toBe(true); expect(replay.providerRoles).toEqual([]);
        }
        const completed = await getJob(state.jobId!);
        expect(completed.terminalOutcome).toBe("succeeded"); expect(completed.contentArtifacts).toHaveLength(1);
        const payload = completed.contentArtifacts![0].payload; if (payload.kind === "x_post") producedTexts.push(payload.text);
        expect(completed.actions).toHaveLength(1); expect(completed.actions[0]).toMatchObject({ type: "export_content_artifact", state: "executed" });
        expect(completed.verifications).toHaveLength(1); expect(completed.verifications![0].verified).toBe(true);
        expect((await repo.readItemState(itemRef)).status).toBe("completed");
      }
      expect(new Set(jobIds).size).toBe(2);
      expect(new Set(producedTexts).size).toBe(2);
      expect((await repo.readCampaign(plan.campaignRef!)).ref).toEqual(base.campaignRef);
      expect((await repo.currentPlan(plan.ref.id)).itemRefs).toEqual(plan.itemRefs);
      await selection.recoverPlannedWork(); expect(await selection.claimNextPlannedItem(plan.ref.id)).toBeNull();
      expect((await awsRepository().query(partition(`workspaces/${plan.ref.workspaceId}/jobs`))).rows).toHaveLength(2);
      expect(bridge.requests.filter(request => request.path === "/api/internal/artifacts" && request.status === 201)).toHaveLength(4);
      expect(bridge.requests.filter(request => request.status >= 400)).toEqual([]);
      const learning = await import("@/lib/learning/repository");
      const observations = await learning.listLearningObservations();
      expect(observations.filter(o => o.kind === "delivery_verification")).toHaveLength(2);
      expect(observations.filter(o => o.kind === "delivery_verification").every(o => o.availability === "available")).toBe(true);
      const manual = observations.find(o => o.measurement.definition.metricId === "operator.review_score")!;
      await learning.recordOperatorObservation({ collectionId: manual.collectionId, requestId: "completed-campaign-review", value: 4, evidenceText: "I reviewed the two exported invitations; the second meets my four-point creative brief rubric." });
      const context = (await learning.learningInsights()).learningContext;
      expect(context.evaluations).toHaveLength(1); expect(context.proposals).toHaveLength(1);
      expect(context.proposals[0]).toMatchObject({ baseStrategyRef: plan.strategyRef });
      const serialized = JSON.parse(execFileSync(resolve("agent/.venv/bin/python"), ["-c", "import json,sys; from harmonia_agent.learning_models import LearningContext; print(LearningContext.model_validate(json.load(sys.stdin)).model_dump_json(exclude_none=False))"], { cwd: resolve("agent"), input: JSON.stringify(context), encoding: "utf8" }));
      const roundtrip = learningInferenceContextSchema.parse(serialized);
      expect(roundtrip.evaluations[0]).toMatchObject({ sampleCount: 1, value: 4, causalClaim: false });
      expect(strategyDigest(roundtrip.observations.find(o => o.id === manual.id)?.measurement ?? roundtrip.evaluations[0].measurement)).toBe(strategyDigest(context.evaluations[0].measurement));
    } finally { await bridge.close(); vi.unstubAllEnvs(); }
  }), 60000);
  it("resolves multi-item plan and campaign advance scopes without item-count ambiguity", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second", operatorBrief: "Imagine a follow-up", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-03T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: [] });
    const planCommand = { action: "advance_plan" as const, targetName: base.planRef.id, requestId: randomUUID(), message: "Advance plan" };
    const claimed = await api.executePlanningChat(planCommand);
    expect(claimed.claim?.itemRef).toEqual(base.itemRefs[0]);
    expect(await api.executePlanningChat(planCommand)).toEqual(claimed);
    const campaign = await api.executePlanningChat({ ...planCommand, targetName: base.campaignRef!.id, requestId: randomUUID() });
    expect(campaign.claim?.jobId).toBe(claimed.claim!.jobId);
  }));
  it.each(["failed", "blocked", "unknown", "unknown_operation", "approved"])("keeps claimed %s work bound when calendar changes are proposed", async mode => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository"); const selection = await import("@/lib/planning/selection");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const claim = await selection.claimNextPlannedItem(base.planRef.id);
    await awsRepository().patch(repo.authorityKey("planned_item_states", base.itemRefs[0]), { status: mode === "failed" ? "failed" : "blocked" });
    const key = recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim!.jobId}`);
    await awsRepository().patch(key, { status: "failed", failure: { stage: "draft", retryable: true }, actions: mode === "approved" ? [{ id: "approved-effect", approvalState: "approved", state: "planned" }] : [] });
    if (mode === "unknown") await awsRepository().put(recordKey(`workspaces/${base.planRef.workspaceId}/effect_commands/unknown-effect`), { workspaceId: base.planRef.workspaceId, brandId: base.planRef.brandId, id: "unknown-effect", jobId: claim!.jobId, state: "unknown" });
    if (mode === "unknown_operation") await awsRepository().put(recordKey(`workspaces/${base.planRef.workspaceId}/operations/unknown-operation`), { workspaceId: base.planRef.workspaceId, brandId: base.planRef.brandId, jobId: claim!.jobId, state: "unknown" });
    const change = await api.replanItem({ itemRef: base.itemRefs[0], scheduledFor: "2026-09-01T12:00:00Z", requestId: randomUUID() });
    expect(change.outcome).toBe("proposal");
    expect((await repo.currentPlan(base.planRef.id)).ref).toEqual(base.planRef);
    expect((await repo.readItemState(base.itemRefs[0])).jobId).toBe(claim!.jobId);
    const proposal = (await awsRepository().read(recordKey(`${repo.campaignRoot()}/planning_proposals/${change.proposalId}`))).value!;
    const disposition = { proposalId: change.proposalId!, expectedAuthorityDigest: strategyDigest(proposal.guarded), decision: "keep_existing_execution" as const, requestId: randomUUID() };
    await expect(api.disposePlanningProposal({ ...disposition, expectedAuthorityDigest: "0".repeat(64) })).rejects.toThrow("authority mismatch");
    const kept = await api.disposePlanningProposal(disposition);
    expect(kept).toMatchObject({ outcome: "kept_existing_execution" });
    expect(await api.disposePlanningProposal(disposition)).toEqual(kept);
    expect((await repo.currentPlan(base.planRef.id)).ref).toEqual(base.planRef);
    expect(await selection.claimNextPlannedItem(base.planRef.id)).toBeNull();
    if (["unknown", "unknown_operation"].includes(mode)) expect(await retryFailedJobWithOutbox(claim!.jobId, "draft")).toBeNull();
  }));
  it("rejects a disposition after the captured execution authority changes", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository"); const selection = await import("@/lib/planning/selection");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const claim = await selection.claimNextPlannedItem(base.planRef.id);
    const change = await api.replanItem({ itemRef: base.itemRefs[0], scheduledFor: "2026-09-01T12:00:00Z", requestId: randomUUID() });
    const proposal = (await awsRepository().read(recordKey(`${repo.campaignRoot()}/planning_proposals/${change.proposalId}`))).value!;
    await awsRepository().patch(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim!.jobId}`), { controlEpoch: 2 });
    await expect(api.disposePlanningProposal({ proposalId: change.proposalId!, expectedAuthorityDigest: strategyDigest(proposal.guarded), decision: "keep_existing_execution", requestId: randomUUID() })).rejects.toThrow("execution authority changed");
    expect((await repo.currentPlan(base.planRef.id)).ref).toEqual(base.planRef);
  }));
  it("preserves a claimed dependent and flags the prerequisite change for exact disposition", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const second = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second", operatorBrief: "Imagine a follow-up", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-03T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: [] });
    // A persisted binding must win even if the calendar lifecycle projection is stale.
    const jobId = `planned-${strategyDigest(second.itemRef).slice(0, 56)}`;
    await awsRepository().put(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${jobId}`), { workspaceId: base.planRef.workspaceId, brandId: base.planRef.brandId, plannedItemRef: second.itemRef, stage: "draft", status: "failed" });
    const result = await api.replanItem({ itemRef: base.itemRefs[0], scheduledFor: "2026-09-01T12:00:00Z", requestId: randomUUID() });
    expect(result.outcome).toBe("proposal");
    expect((await repo.currentPlan(base.planRef.id)).itemRefs).toEqual([...base.itemRefs, second.itemRef]);
    expect((await repo.readItemState(second.itemRef)).dispositionProposalId).toBe(result.proposalId);
    expect((await repo.readPlannedItem(second.itemRef)).dependencies).toEqual(base.itemRefs);
  }));
  it("revises unclaimed dependencies atomically when a prerequisite is rescheduled", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const second = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second", operatorBrief: "Imagine a follow-up", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-03T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: [] });
    const result = await api.replanItem({ itemRef: base.itemRefs[0], scheduledFor: "2026-09-01T12:00:00Z", requestId: randomUUID() });
    expect(result.outcome).toBe("applied");
    const current = await repo.currentPlan(base.planRef.id); const dependent = await repo.readPlannedItem(current.itemRefs.find(ref => ref.id === second.itemRef.id)!);
    expect(dependent.ref.revision).toBe(2); expect(dependent.dependencies).toEqual([result.itemRef]);
  }));
  it("does not enqueue a failed job retry while another item occupies concurrency", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository"); const selection = await import("@/lib/planning/selection");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const second = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second", operatorBrief: "Imagine a follow-up", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2098-09-03T12:00:00Z", dependencies: [], requiredAssetIds: [] });
    const claim = await selection.claimNextPlannedItem(base.planRef.id);
    await markFailed({ jobId: claim!.jobId, stage: "draft", category: "dependency", code: "temporary", publicMessage: "Unavailable", retryable: true, operationId: `job:${claim!.jobId}:stage:draft:generation:0`, traceId: "a".repeat(32), attempt: 1, maxAttempts: 3, details: {} });
    const other = await selection.claimNextPlannedItem(base.planRef.id, "2099-01-01T00:00:00Z"); expect(other?.itemRef).toEqual(second.itemRef);
    const before = await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/stage_outbox`));
    expect(await retryFailedJobWithOutbox(claim!.jobId, "draft")).toBeNull();
    expect((await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/stage_outbox`))).rows).toHaveLength(before.rows.length);
    expect(await repo.readItemState(base.itemRefs[0])).toMatchObject({ status: "failed", retryPending: true });
    await awsRepository().patch(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${other!.jobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
    await selection.reconcilePlannedExecution(other!.jobId);
    const resumed = await repo.readItemState(base.itemRefs[0]);
    expect(resumed).toMatchObject({ status: "running", jobId: claim!.jobId, retryPending: false }); expect(resumed.outboxId).not.toBe(claim!.outboxId);
    await selection.recoverPlannedWork();
    expect(await retryFailedJobWithOutbox(claim!.jobId, "draft")).toBe(resumed.outboxId);
    expect((await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/stage_outbox`))).rows).toHaveLength(before.rows.length + 1);
  }));
  it("resumes an administrator-authorized permanent retry after occupied capacity clears", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository"); const selection = await import("@/lib/planning/selection");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const second = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Second", operatorBrief: "Imagine a follow-up", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2098-09-03T12:00:00Z", dependencies: [], requiredAssetIds: [] });
    const claim = (await selection.claimNextPlannedItem(base.planRef.id))!;
    await markFailed({ jobId: claim.jobId, stage: "draft", category: "validation", code: "fixed_contract", publicMessage: "Contract rejected", retryable: false, operationId: `job:${claim.jobId}:stage:draft:generation:0`, traceId: "a".repeat(32), attempt: 1, maxAttempts: 3, details: {} });
    const other = (await selection.claimNextPlannedItem(base.planRef.id, "2099-01-01T00:00:00Z"))!; expect(other.itemRef).toEqual(second.itemRef);
    const before = await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/stage_outbox`));
    const jobs = await import("@/lib/repository"); const failed = await getJob(claim.jobId);
    const input = { requestId: randomUUID(), afterFix: true as const, reason: "Deployed the draft contract correction", expectedGeneration: failed.controlEpoch, expectedFailure: failed.failure! };
    const authorization = await jobs.authorizePermanentJobRetry(claim.jobId, input);
    expect(authorization).toMatchObject({ retryPending: true, outboxId: null });
    const authKey = recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}/permanent_retry_authorizations/${authorization.authorizationId}`);
    const pending = await awsRepository().read(authKey);
    expect(pending.value).toMatchObject({ workspaceId: base.planRef.workspaceId, brandId: "a", jobId: claim.jobId, itemRef: claim.itemRef, expectedGeneration: 0, failureDigest: strategyDigest(failed.failure), decision: "retry_after_fix", reason: input.reason, state: "pending", actor: { subjectId: "operator", workspaceRole: "owner" } });
    expect(pending.value?.approvedAt).toBeTruthy(); expect(pending.value?.idempotencyKey).toBe(input.requestId);
    expect(await jobs.authorizePermanentJobRetry(claim.jobId, input)).toMatchObject({ replayed: true, retryPending: true });
    expect(await awsRepository().read(authKey)).toEqual(pending);
    expect(await repo.readItemState(claim.itemRef)).toMatchObject({ status: "failed", retryPending: true });
    expect((await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/stage_outbox`))).rows).toHaveLength(before.rows.length);
    await awsRepository().patch(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${other.jobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
    await selection.reconcilePlannedExecution(other.jobId);
    const resumed = await repo.readItemState(claim.itemRef);
    expect(resumed).toMatchObject({ status: "running", jobId: claim.jobId, retryPending: false });
    expect(resumed.outboxId).not.toBe(claim.outboxId);
    const consumed = await awsRepository().read(authKey);
    expect(consumed.value).toMatchObject({ state: "consumed", outboxId: resumed.outboxId, admittedGeneration: 1 });
    const stableJob = await awsRepository().read(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}`));
    const stableItem = await repo.readItemState(claim.itemRef);
    await Promise.all([selection.resumePendingPlannedRetries(), selection.resumePendingPlannedRetries()]);
    expect(await jobs.authorizePermanentJobRetry(claim.jobId, input)).toMatchObject({ replayed: true, outboxId: resumed.outboxId, retryPending: false });
    expect(await awsRepository().read(authKey)).toEqual(consumed);
    expect(await awsRepository().read(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}`))).toEqual(stableJob);
    expect(await repo.readItemState(claim.itemRef)).toEqual(stableItem);
    expect((await repo.readItemState(claim.itemRef)).outboxId).toBe(resumed.outboxId);
    expect((await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/stage_outbox`))).rows).toHaveLength(before.rows.length + 1);
  }));
  it.each(["failure", "generation", "stage", "item", "missing_failure"])("rejects permanent retry authorization after its exact %s changes", async change => runWithTenant(tenant(), async () => {
    const { base, claim, other, repo, selection, job, input } = await permanentRetryPair(); const jobs = await import("@/lib/repository");
    const grant = await jobs.authorizePermanentJobRetry(claim.jobId, input);
    const key = recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}`);
    await awsRepository().patch(key, change === "failure" ? { failure: { ...job.failure, code: "different_failure" } } : change === "stage" ? { failure: { ...job.failure, stage: "publish" } } : change === "item" ? { plannedItemRef: other.itemRef } : change === "missing_failure" ? { failure: REMOVE_FIELD } : { controlEpoch: 1 });
    await awsRepository().patch(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${other.jobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
    await selection.reconcilePlannedExecution(other.jobId);
    expect(await repo.readItemState(claim.itemRef)).toMatchObject({ status: "failed", retryPending: false, reason: expect.stringContaining("stale") });
    expect((await awsRepository().read(recordKey(`${key.path}/permanent_retry_authorizations/${grant.authorizationId}`))).value?.state).toBe("stale");
    expect((await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/stage_outbox`))).rows).toHaveLength(2);
    if (change !== "item") await expect(jobs.authorizePermanentJobRetry(claim.jobId, { ...input, requestId: randomUUID() })).rejects.toThrow("failure or generation changed");
    expect(await jobs.authorizePermanentJobRetry(claim.jobId, input)).toMatchObject({ replayed: true, retryPending: false, outboxId: null });
  }));
  it("replays the authenticated permanent-retry API without writes or dispatch and rejects stale decisions", async () => {
    const scope = tenant(); const cognito = await import("@/lib/cognito");
    const uid = `retry-api-${randomUUID()}`;
    const verify = vi.spyOn(cognito, "verifyCognitoIdentity").mockResolvedValue({ uid, email: "test@example.test", exp: Math.floor(Date.now() / 1000) + 3600 } as Awaited<ReturnType<typeof cognito.verifyCognitoIdentity>>);
    try {
      const auth = await import("@/lib/auth"); const route = await import("@/app/api/jobs/[id]/retry/route");
      const cookie = (await auth.createSessionCookie("offline-verified-identity")).split(";")[0];
      const userKey = recordKey(`users/${uid}`); const memberKey = recordKey(`workspaces/${scope.workspaceId}/members/${uid}`);
      await awsRepository().put(userKey, { defaultWorkspaceId: scope.workspaceId, defaultBrandId: scope.brandId });
      await awsRepository().put(memberKey, { userId: uid, role: "admin" });
      await runWithTenant(scope, async () => {
        const { base, claim, other, selection, input } = await permanentRetryPair();
        const send = (body = input) => route.POST(new Request(`http://localhost/api/jobs/${claim.jobId}/retry`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: claim.jobId }) });
        const response = await send(); expect(response.status).toBe(202); const pending = await response.json();
        const key = recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}/permanent_retry_authorizations/${pending.authorizationId}`);
        const record = await awsRepository().read(key);
        expect(await (await send()).json()).toEqual(pending); expect(await awsRepository().read(key)).toEqual(record);
        await awsRepository().put(memberKey, { userId: uid, role: "member" });
        expect((await send()).status).toBe(403);
        await awsRepository().put(memberKey, { userId: uid, role: "admin" });
        await awsRepository().patch(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${other.jobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
        await selection.reconcilePlannedExecution(other.jobId);
        const consumed = await awsRepository().read(key); const jobKey = recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}`); const before = await awsRepository().read(jobKey);
        const outboxKey = recordKey(`workspaces/${base.planRef.workspaceId}/stage_outbox/${consumed.value?.outboxId}`); const outbox = await awsRepository().read(outboxKey);
        const replay = await send(); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ state: "consumed", retryPending: false, outboxId: consumed.value?.outboxId });
        expect(await awsRepository().read(key)).toEqual(consumed); expect(await awsRepository().read(jobKey)).toEqual(before); expect(await awsRepository().read(outboxKey)).toEqual(outbox);
        expect((await send({ ...input, requestId: randomUUID() })).status).toBe(409);
      });
    } finally { verify.mockRestore(); }
  });
  it("requires a fresh permanent retry authorization for a new failure and denies non-admin or cross-brand use", async () => {
    const scope = tenant(); await runWithTenant(scope, async () => {
      const { base, claim, other, repo, selection, input } = await permanentRetryPair(); const jobs = await import("@/lib/repository");
      const member: TenantContext = { ...scope, principal: { kind: "cognito_user", subjectId: "member", authenticationId: "auth", workspaceRole: "member" } };
      await expect(runWithTenant(member, () => jobs.authorizePermanentJobRetry(claim.jobId, input))).rejects.toThrow("administrator required");
      const grant = await jobs.authorizePermanentJobRetry(claim.jobId, input);
      await expect(runWithTenant(member, () => retryFailedJobWithOutbox(claim.jobId, "draft", { permanentAuthorizationId: grant.authorizationId }))).rejects.toThrow("administrator required");
      await expect(runWithTenant({ ...scope, brandId: "b" }, () => retryFailedJobWithOutbox(claim.jobId, "draft", { permanentAuthorizationId: grant.authorizationId }))).rejects.toThrow("brand access denied");
      await expect(runWithTenant({ ...scope, brandId: "b" }, () => jobs.authorizePermanentJobRetry(claim.jobId, input))).rejects.toThrow("brand access denied");
      await expect(jobs.authorizePermanentJobRetry(claim.jobId, { ...input, reason: "Different decision" })).rejects.toThrow("identity reused");
      await awsRepository().patch(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${other.jobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
      await runWithTenant({ ...scope, principal: { kind: "service", subjectId: "harmonia-worker", authenticationId: "worker", workspaceRole: "service" } }, () => selection.reconcilePlannedExecution(other.jobId));
      const resumed = await repo.readItemState(claim.itemRef);
      const oldOutbox = resumed.outboxId;
      await markFailed({ jobId: claim.jobId, stage: "draft", category: "validation", code: "new_failure", publicMessage: "New failure", retryable: false, operationId: `job:${claim.jobId}:stage:draft:generation:1`, traceId: "b".repeat(32), attempt: 1, maxAttempts: 3, details: {} });
      await selection.resumePendingPlannedRetries();
      expect(await repo.readItemState(claim.itemRef)).toMatchObject({ status: "failed", outboxId: oldOutbox });
      expect(await jobs.authorizePermanentJobRetry(claim.jobId, input)).toMatchObject({ replayed: true, outboxId: oldOutbox });
      expect((await getJob(claim.jobId)).failure?.code).toBe("new_failure");
      const current = await getJob(claim.jobId);
      const next = await jobs.authorizePermanentJobRetry(claim.jobId, { ...input, requestId: randomUUID(), expectedGeneration: current.controlEpoch, expectedFailure: current.failure! });
      expect(next.outboxId).not.toBe(oldOutbox); expect((await getJob(claim.jobId)).controlEpoch).toBe(2);
      expect((await awsRepository().query(partition(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}/permanent_retry_authorizations`))).rows).toHaveLength(2);
    });
  });
  it.each(["not_a_stage", "complete"])("rejects permanent retry from non-executable stage %s without retaining authority", async stage => runWithTenant(tenant(), async () => {
    const { base, claim, input } = await permanentRetryPair(); const jobs = await import("@/lib/repository");
    const key = recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${claim.jobId}`);
    await awsRepository().patch(key, { failure: { ...input.expectedFailure, stage } });
    const job = await getJob(claim.jobId);
    await expect(jobs.authorizePermanentJobRetry(claim.jobId, { ...input, expectedFailure: job.failure! })).rejects.toThrow("stage is not retryable");
    expect((await awsRepository().query(partition(`${key.path}/permanent_retry_authorizations`))).rows).toHaveLength(0);
  }));
  it("does not carry a permanent authorization into a later transient retry", async () => runWithTenant(tenant(), async () => {
    const { base, claim, other, repo, selection, input } = await permanentRetryPair(); const jobs = await import("@/lib/repository");
    await jobs.authorizePermanentJobRetry(claim.jobId, input);
    await markFailed({ jobId: claim.jobId, stage: "draft", category: "provider_transient", code: "new_transient_failure", publicMessage: "Temporarily unavailable", retryable: true, operationId: `job:${claim.jobId}:stage:draft:generation:0`, traceId: "b".repeat(32), attempt: 2, maxAttempts: 3, details: {} });
    expect(await retryFailedJobWithOutbox(claim.jobId, "draft")).toBeNull();
    expect((await repo.readItemState(claim.itemRef)).permanentRetryAuthorizationId).toBeUndefined();
    await awsRepository().patch(recordKey(`workspaces/${base.planRef.workspaceId}/jobs/${other.jobId}`), { status: "complete", stage: "complete", terminalOutcome: "succeeded" });
    await selection.reconcilePlannedExecution(other.jobId);
    expect(await repo.readItemState(claim.itemRef)).toMatchObject({ status: "running", jobId: claim.jobId, retryPending: false });
    expect((await getJob(claim.jobId)).controlEpoch).toBe(1);
  }));
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
  it("exposes cancelled dependencies and unavailable validated assets, preserves approved work as a proposal", async () => runWithTenant(tenant(), async () => {
    await setup(); const api = await import("@/lib/planning/commands"); const repo = await import("@/lib/campaigns/repository");
    const draft = await request(); const base = await api.materializeIntake({ draftId: draft.id, expectedDraftRevision: 1, requestId: draft.answers.at(-1)!.requestId });
    const artifact = await createArtifactStore(awsRepository()).create({ jobId: "asset-readiness", operationId: "design-upload", bytes: Buffer.from("Approved design"), contentType: "text/plain", trust: "operator", producer: { kind: "operator", id: "operator", version: "1" }, retentionClass: "audit" });
    const second = await api.addPlannedDeliverable({ planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Follow-up", operatorBrief: "Imagine the next step", requestedOutputs: ["x_post"], channel: "x", scheduledFor: "2026-09-01T12:00:00Z", dependencies: base.itemRefs, requiredAssetIds: [artifact.id] });
    await awsRepository().patch(recordKey(`${tenantCollectionPath(currentTenant(), "artifacts")}/${artifact.id}`), { state: "failed", failureReason: "asset withdrawn after planning" });
    await awsRepository().patch(repo.authorityKey("planned_item_states", base.itemRefs[0]), { status: "cancelled" });
    const selection = await import("@/lib/planning/selection");
    expect(await selection.claimNextPlannedItem(base.planRef.id)).toBeNull();
    expect(await repo.readItemState(second.itemRef)).toMatchObject({ status: "blocked", reason: expect.stringContaining("cancelled") });
    expect((await repo.readItemState(second.itemRef)).reason).toContain(`asset ${artifact.id}`);
    await awsRepository().patch(repo.authorityKey("planned_item_states", second.itemRef), { status: "awaiting_approval" });
    const change = await api.replanItem({ itemRef: second.itemRef, scheduledFor: "2026-09-07T12:00:00Z", requestId: randomUUID() });
    expect(change.outcome).toBe("proposal"); expect(change.reasons).toContain("claimed or approved work requires exact execution disposition");
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
