import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { actionPayloadDigest } from "@/lib/idempotency";
import { acceptStrategyProposal, decideStrategy, getJob, saveConnection, saveStrategyInvocationContext } from "@/lib/repository";
import { configurePlanningPolicy, readItemState, readPlannedItem } from "@/lib/campaigns/repository";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { executeIntakeDraft } from "@/lib/intake/commands";
import { materializeIntake } from "@/lib/planning/commands";
import { claimNextPlannedItem } from "@/lib/planning/selection";
import { resolveDecision } from "@/lib/decisions";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { strategyDigest } from "@/lib/strategyApproval";
import { readActiveStrategyRef } from "@/lib/strategy/repository";
import { createEffectCommand, effectCommandDigest } from "@/lib/effectCommands";
import { claimCommandEffect, createCommand, getCommand, transitionCommandEffect } from "@/lib/effectCommandStore";
import { strategyFixture } from "./fixtures/strategy";
import { campaignWorkerBridge } from "./fixtures/campaignWorkerBridge";
import { buildStageMessage } from "@/lib/queue";
import type { StageOutboxRecord } from "@/lib/stageOutbox";
import type { PlannedAction } from "@/lib/types";

const tenant = (): TenantContext => ({
  workspaceId: `task7-${randomUUID()}`,
  brandId: "new-brand",
  principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "local-acceptance", workspaceRole: "owner" },
});

const strategyContext: import("@/lib/types").StrategyContext = {
  company: "Task Seven Studio", product: "A collaboration tool for startup teams", positioning: "calm execution", differentiators: ["durable approvals"], brandVoice: ["clear", "helpful"], exclusions: ["performance claims"], safetyConstraints: ["do not invent facts"], businessObjectives: ["invite qualified founders"], campaignObjectives: ["start conversations"], audiences: [{ id: "founders", name: "Startup founders", pains: ["too many tools"] }], funnelStage: "consideration", intendedConversion: "conversation", requestedChannels: ["x"], supportedChannels: ["x"],
};

async function approveInitialStrategy() {
  const firstRequestId = randomUUID();
  const conversationId = randomUUID();
  const initial = await submitIntakeTurn({
    requestId: firstRequestId, conversationId, surface: "dashboard",
    message: "Establish a content strategy for our new startup brand.",
    advice: { action: "establish_strategy", disposition: "new_initiative", expectedOutcome: "", requestedOutputs: [], sourceHandles: [], strategyContext },
  });
  expect(initial.state).toBe("clarifying");
  expect(initial.missingFields).toContain("expectedOutcome");
  const clarified = await submitIntakeTurn({
    requestId: randomUUID(), conversationId, surface: "dashboard",
    message: "The outcome is to start useful conversations with startup founders.",
    advice: { action: "establish_strategy", disposition: "new_initiative", expectedOutcome: "Start useful conversations with startup founders", requestedOutputs: [], sourceHandles: [], strategyContext },
  });
  expect(clarified.id).toBe(initial.id);
  expect(clarified.state).toBe("ready");
  const dispatch = await executeIntakeDraft(clarified);
  const job = await getJob(dispatch.jobId!);
  expect(job.stage).toBe("strategize");
  await saveStrategyInvocationContext(job.id, {
    revision: 1, sourceIds: [], operatorContextIds: ["context:campaign", "context:company"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [],
  });
  const strategy = strategyFixture("task7-initial");
  for (const group of [strategy.pillars, strategy.campaignThemes, strategy.briefs]) for (const item of group) item.evidenceRefs = ["context:company"];
  const digest = strategyDigest(strategy);
  await acceptStrategyProposal(job.id, strategy, digest, 1, [], null);
  const approved = await decideStrategy(job.id, { decision: "approved", payloadDigest: digest, expectedActiveRevision: 0 });
  expect(approved.strategyRef).toBeTruthy();
  expect((await getJob(job.id)).terminalOutcome).toBe("succeeded");
  return approved.strategyRef!;
}

async function nextStage(bridge: Awaited<ReturnType<typeof campaignWorkerBridge>>, jobId: string, stage: string) {
  const rows = await awsRepository().query(partition(`workspaces/${tenantScope().workspaceId}/stage_outbox`));
  const outbox = rows.rows.find((row) => row.value?.jobId === jobId && row.value?.stage === stage)?.value as StageOutboxRecord | undefined;
  if (!outbox) throw new Error(`missing ${stage} outbox for ${jobId}`);
  const message = buildStageMessage(await getJob(jobId).then(job => job.planRef!), outbox);
  const input = { event: JSON.parse(message.data.toString()), carrier: message.attributes, transportId: randomUUID() };
  const result = await bridge.run(input);
  expect(result, JSON.stringify(bridge.requests.filter((request) => request.status >= 400))).toMatchObject({ acknowledged: true, result: { ack: true } });
  return { input, result };
}

let currentScope: TenantContext;
const tenantScope = () => currentScope;

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("Task 7 local acceptance", () => {
  it("drives a clarified new brand through approved strategy, campaign work, rejected publish, verified export, and redelivery", async () => {
    currentScope = tenant();
    await runWithTenant(currentScope, async () => {
      vi.stubEnv("HARMONIA_CONNECTION_ENVELOPE_KEY_RAW", "0123456789abcdefghijklmnopqrstuv");
      await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 4, maxItemsPerWeek: 4 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
      const strategyRef = await approveInitialStrategy();
      vi.stubEnv("INTERNAL_API_TOKEN", "task7-local-worker-token");
      vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1");
      vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
      // This is a local-only connection fixture. The publish action below is rejected before
      // the worker can call any provider adapter; it is not a claimed social-provider success.
      await saveConnection({ platform: "x", mode: "manual", accessToken: "local-not-used", connectedAt: new Date().toISOString(), health: "active" });
      const draft = await submitIntakeTurn({
        requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard",
        message: "Create an urgent founder invitation for this week.",
        advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "Invite founders to a useful conversation", requestedOutputs: ["x_post"], sourceHandles: [], targetName: "Founder invitation" },
      });
      const materialized = await materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
      expect((await readPlannedItem(materialized.itemRefs[0])).strategyRef).toEqual(strategyRef);
      expect(materialized.campaignRef).toBeTruthy();
      const claim = await claimNextPlannedItem(materialized.planRef.id);
      expect(claim?.itemRef).toEqual(materialized.itemRefs[0]);
      const bridge = await campaignWorkerBridge();
      try {
        const drafted = await nextStage(bridge, claim!.jobId, "draft");
        expect(drafted.result.providerRoles).toEqual(["noni_artifact_producer", "dara_artifact_editor"]);
        const awaiting = await getJob(claim!.jobId);
        expect(awaiting.stage).toBe("awaiting_approval");
        const publish = awaiting.actions.find((action) => action.type === "publish_x_post")!;
        expect(publish.approvalState).toBe("pending");
        await expect(resolveDecision(claim!.jobId, publish.id, "rejected", "0".repeat(64))).rejects.toThrow("approval payload changed");
        expect(await resolveDecision(claim!.jobId, publish.id, "rejected", actionPayloadDigest(publish))).toMatchObject({ ok: true, triggered: "publish" });
        const afterDecision = await getJob(claim!.jobId);
        expect(afterDecision.actions.find((action) => action.id === publish.id)).toMatchObject({ approvalState: "rejected", state: "skipped" });
        expect(afterDecision.actions.find((action) => action.type === "export_content_artifact")).toMatchObject({ approvalState: "not_required", state: "planned" });
        const published = await nextStage(bridge, claim!.jobId, "publish");
        const replay = await bridge.run({ ...published.input, transportId: randomUUID(), deliveryAttempt: 2 });
        expect(replay.result.duplicate).toBe(true);
        await nextStage(bridge, claim!.jobId, "verify");
        await nextStage(bridge, claim!.jobId, "learn");
        let finished = await getJob(claim!.jobId);
        // Learning may terminally reconcile this local export without a separate
        // complete delivery; when it does emit one, exercise that delivery too.
        if (finished.stage === "complete" && finished.terminalOutcome !== "succeeded") {
          const complete = await nextStage(bridge, claim!.jobId, "complete");
          expect((complete.result as { failed?: boolean }).failed).not.toBe(true);
          finished = await getJob(claim!.jobId);
        }
        expect(finished).toMatchObject({ terminalOutcome: "succeeded" });
        expect(finished.verifications).toContainEqual(expect.objectContaining({ verified: true, method: "artifact_digest_reread" }));
        expect(await readItemState(materialized.itemRefs[0])).toMatchObject({ status: "completed", jobId: claim!.jobId });
        expect(bridge.requests.filter((request) => request.status >= 400)).toEqual([]);
      } finally {
        await bridge.close();
        vi.unstubAllEnvs();
      }
    });
  }, 60_000);

  it("keeps urgent independent work out of campaigns and gives simultaneous workers one restart-safe execution", async () => {
    currentScope = tenant();
    await runWithTenant(currentScope, async () => {
      await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 4, maxItemsPerWeek: 4 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
      await approveInitialStrategy();
      const draft = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Urgently draft a standalone founder update; do not add it to a campaign.", advice: { action: "create_job", disposition: "independent", expectedOutcome: "Address an urgent founder question", requestedOutputs: ["x_post"], sourceHandles: [] } });
      const planned = await materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
      expect(planned.campaignRef).toBeNull();
      const [first, second] = await Promise.all([claimNextPlannedItem(planned.planRef.id), claimNextPlannedItem(planned.planRef.id)]);
      expect(first?.jobId).toBeTruthy();
      expect(second?.jobId).toBe(first?.jobId);
      expect((await awsRepository().query(partition(`workspaces/${currentScope.workspaceId}/stage_outbox`))).rows.filter((row) => row.value?.jobId === first?.jobId)).toHaveLength(1);
    });
  });

  it("retains knowledge without dispatch, blocks revoked source proposals, and quarantines an unknown provider outcome", async () => {
    currentScope = tenant();
    await runWithTenant(currentScope, async () => {
      await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 4, maxItemsPerWeek: 4 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
      const strategyRef = await approveInitialStrategy();
      const knowledge = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Keep https://example.com/founder-research as knowledge only.", advice: { action: "create_job", disposition: "knowledge_only", expectedOutcome: "Retain source context", requestedOutputs: [], sourceHandles: [{ kind: "web", url: "https://example.com/founder-research" }] } });
      expect(knowledge.state).toBe("retained");
      expect((await executeIntakeDraft(knowledge)).jobId).toBeUndefined();
      const root = `workspaces/${currentScope.workspaceId}/brands/${currentScope.brandId}`;
      await awsRepository().put(recordKey(`${root}/sources/research-source`), { workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, id: "research-source", state: "ready", contentDigest: "a".repeat(64) });
      const proposals = await import("@/lib/learning/proposals");
      const discovery = await proposals.recordSourceDiscovery("research-source");
      const rejected = await proposals.createStrategyChangeProposal({ requestId: "reject-source", baseStrategyRef: strategyRef, changes: [{ type: "cadence_guidance", value: "Review weekly" }], rationale: "Source discovery needs a human strategy decision", evidenceRefs: [{ id: discovery.id, digest: discovery.digest }], contradictionRefs: [] });
      expect((await proposals.decideStrategyChange({ id: rejected.id, revision: rejected.revision, digest: rejected.digest, decision: "rejected", feedback: "Not enough evidence" })).status).toBe("rejected");
      const feedback = await proposals.recordOperatorFeedback({ requestId: "approved-feedback", text: "Use a clear invitation CTA.", sourceIds: [] });
      const approved = await proposals.createStrategyChangeProposal({ requestId: "approve-feedback", baseStrategyRef: strategyRef, changes: [{ type: "cta_guidance", value: ["Invite founders to share their workflow"] }], rationale: "Separate operator-approved change", evidenceRefs: [{ id: feedback.id, digest: feedback.digest }], contradictionRefs: [] });
      expect((await proposals.decideStrategyChange({ id: approved.id, revision: approved.revision, digest: approved.digest, decision: "approved" })).approvedStrategyRef?.revision).toBe(strategyRef.revision + 1);
      const revoked = await proposals.createStrategyChangeProposal({ requestId: "revoked-source", baseStrategyRef: await readActiveStrategyRef() as NonNullable<typeof strategyRef>, changes: [{ type: "cadence_guidance", value: "Review monthly" }], rationale: "This proposal must become unavailable after source withdrawal", evidenceRefs: [{ id: discovery.id, digest: discovery.digest }], contradictionRefs: [] });
      const { revokeSourceKnowledge } = await import("@/lib/sourceKnowledgeErasure");
      await revokeSourceKnowledge("research-source");
      await expect(proposals.decideStrategyChange({ id: revoked.id, revision: revoked.revision, digest: revoked.digest, decision: "approved" })).rejects.toThrow(/revoked|unavailable/);

      const jobId = `unknown-${randomUUID()}`;
      const action: PlannedAction = { id: "publish", jobId, type: "publish_x_post", title: "Publish", description: "", risk: "high", requiresApproval: true, approvalState: "approved", payload: { text: "A locally quarantined outcome" }, state: "planned" };
      await awsRepository().put(recordKey(`workspaces/${currentScope.workspaceId}/jobs/${jobId}`), { workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, createdByUserId: "operator", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stage: "publish", status: "running", config: { platforms: ["x"] }, actions: [action] });
      await awsRepository().put(recordKey(`workspaces/${currentScope.workspaceId}/jobs/${jobId}/approval_decisions/${action.id}`), { id: action.id, jobId, actionId: action.id, decision: "approved", payloadDigest: actionPayloadDigest(action), actorType: "cognito_operator", actorSubjectId: "operator", authenticationId: "local-acceptance", channel: "dashboard", operationId: `${jobId}:approval:${action.id}`, traceId: "a".repeat(32), decidedAt: new Date().toISOString() });
      const draft = { id: "unknown-command", workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, sourceKind: "job_action" as const, sourceId: action.id, jobId, actionId: action.id, actionType: action.type, payload: action.payload };
      const command = createEffectCommand({ ...draft, authorization: { kind: "approval", approvalId: action.id, approvedPayloadDigest: effectCommandDigest({ ...draft, authorization: { kind: "approval", approvalId: action.id, approvedPayloadDigest: "pending" } }) } });
      await createCommand(command);
      const operationId = `job:${jobId}:effect:${command.id}`;
      const claimed = await claimCommandEffect(command.id, { operationId, traceId: "b".repeat(32), claimToken: "local-owner" });
      if (claimed.outcome !== "execute" || !claimed.claim.operationEpoch) throw new Error("effect command was not claimed");
      const fence = { operationId, epoch: claimed.claim.operationEpoch, workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, now: new Date().toISOString() };
      await transitionCommandEffect(command.id, { phase: "dispatched", claimToken: "local-owner", attempt: 1 }, fence);
      await transitionCommandEffect(command.id, { phase: "unknown", claimToken: "local-owner", reason: "local provider response intentionally unavailable" }, { ...fence, now: new Date().toISOString() });
      expect(await getCommand(command.id)).toMatchObject({ state: "unknown", unknownReason: "local provider response intentionally unavailable" });
      await expect(claimCommandEffect(command.id, { operationId, traceId: "c".repeat(32), claimToken: "must-not-replay" })).rejects.toThrow("effect command is unknown");
    });
  });
});
