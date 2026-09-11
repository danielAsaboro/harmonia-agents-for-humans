import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { actionPayloadDigest } from "@/lib/idempotency";
import { decideStrategy, getJob, saveConnection } from "@/lib/repository";
import { configurePlanningPolicy, readItemState, readPlannedItem } from "@/lib/campaigns/repository";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { executeIntakeDraft } from "@/lib/intake/commands";
import { intakeSourceKey } from "@/lib/intake/contracts";
import { materializeIntake } from "@/lib/planning/commands";
import { claimNextPlannedItem } from "@/lib/planning/selection";
import { resolveDecision } from "@/lib/decisions";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { readActiveStrategyRef } from "@/lib/strategy/repository";
import { getCommand } from "@/lib/effectCommandStore";
import { saveChatAttachment } from "@/lib/chatAttachments";
import { campaignWorkerBridge } from "./fixtures/campaignWorkerBridge";
import { buildStageMessage } from "@/lib/queue";
import { withTraceContext } from "@/lib/telemetry";
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

async function approveInitialStrategy(bridge: Awaited<ReturnType<typeof campaignWorkerBridge>>) {
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
  await nextStage(bridge, job.id, "strategize");
  const proposed = await getJob(job.id);
  expect(proposed.strategyApprovalState).toBe("pending");
  expect(bridge.requests.map(request => request.path), JSON.stringify(bridge.requests)).toEqual(expect.arrayContaining(["/api/internal/strategy-context", "/api/internal/strategy"]));
  const approved = await decideStrategy(job.id, { decision: "approved", payloadDigest: proposed.strategyDigest!, expectedActiveRevision: 0 });
  expect(approved.strategyRef).toBeTruthy();
  expect((await getJob(job.id)).terminalOutcome).toBe("succeeded");
  return approved.strategyRef!;
}

async function nextStage(bridge: Awaited<ReturnType<typeof campaignWorkerBridge>>, jobId: string, stage: string) {
  const rows = await awsRepository().query(partition(`workspaces/${tenantScope().workspaceId}/stage_outbox`));
  const outbox = rows.rows.find((row) => row.value?.jobId === jobId && row.value?.stage === stage)?.value as StageOutboxRecord | undefined;
  if (!outbox) throw new Error(`missing ${stage} outbox for ${jobId}`);
  const message = buildStageMessage(tenantScope(), outbox);
  const input = { event: JSON.parse(message.data.toString()), carrier: message.attributes, transportId: randomUUID() };
  const result = await bridge.run(input);
  expect(result, JSON.stringify(bridge.requests.filter((request) => request.status >= 400))).toMatchObject({ acknowledged: true, result: { ack: true } });
  return { input, result };
}

let currentScope: TenantContext;
const tenantScope = () => currentScope;
const operatorDecision = <T>(work: () => Promise<T>) => withTraceContext(new Headers(), work);

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("Task 7 local acceptance", () => {
  it("drives a clarified new brand through approved strategy, campaign work, rejected publish, verified export, and redelivery", async () => {
    currentScope = tenant();
    await runWithTenant(currentScope, async () => {
      vi.stubEnv("HARMONIA_CONNECTION_ENVELOPE_KEY_RAW", "0123456789abcdefghijklmnopqrstuv");
      vi.stubEnv("INTERNAL_API_TOKEN", "task7-local-worker-token");
      vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1");
      vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
      // This is a local-only connection fixture. The publish action below is rejected before
      // the worker can call any provider adapter; it is not a claimed social-provider success.
      await saveConnection({ platform: "x", mode: "manual", accessToken: "local-not-used", connectedAt: new Date().toISOString(), health: "active" });
      const bridge = await campaignWorkerBridge();
      try {
      await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 4, maxItemsPerWeek: 4 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
      const strategyRef = await approveInitialStrategy(bridge);
      const draft = await submitIntakeTurn({
        requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard",
        message: "Create an urgent founder invitation for this week.",
        advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "Invite founders to a useful conversation", requestedOutputs: ["x_post", "content_pack"], sourceHandles: [], targetName: "Founder invitation" },
      });
      const materialized = await materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
      expect((await readPlannedItem(materialized.itemRefs[0])).strategyRef).toEqual(strategyRef);
      expect(materialized.campaignRef).toBeTruthy();
      const claim = await claimNextPlannedItem(materialized.planRef.id);
      expect(claim?.itemRef).toEqual(materialized.itemRefs[0]);
        const drafted = await nextStage(bridge, claim!.jobId, "draft");
        expect(drafted.result.providerRoles).toEqual(expect.arrayContaining(["noni_artifact_producer", "dara_artifact_editor"]));
        const awaiting = await getJob(claim!.jobId);
        expect(awaiting.stage).toBe("awaiting_approval");
        const publish = awaiting.actions.find((action) => action.type === "publish_x_post")!;
        const contentPack = awaiting.actions.find((action) => action.type === "export_content_artifact" && action.payload.outputType === "content_pack")!;
        expect(publish.approvalState).toBe("pending");
        expect(contentPack.approvalState).toBe("pending");
        await expect(operatorDecision(() => resolveDecision(claim!.jobId, contentPack.id, "approved", "0".repeat(64)))).rejects.toThrow("approval payload changed");
        expect(await operatorDecision(() => resolveDecision(claim!.jobId, contentPack.id, "approved", actionPayloadDigest(contentPack)))).toMatchObject({ ok: true, remainingApprovals: 1 });
        expect(await operatorDecision(() => resolveDecision(claim!.jobId, publish.id, "rejected", actionPayloadDigest(publish)))).toMatchObject({ ok: true, triggered: "publish" });
        const afterDecision = await getJob(claim!.jobId);
        expect(afterDecision.actions.find((action) => action.id === publish.id)).toMatchObject({ approvalState: "rejected", state: "skipped" });
        expect(afterDecision.actions.find((action) => action.id === contentPack.id)).toMatchObject({ approvalState: "approved", state: "planned" });
        const published = await nextStage(bridge, claim!.jobId, "publish");
        const replay = await bridge.run({ ...published.input, transportId: randomUUID(), deliveryAttempt: 2 });
        expect(replay.result.duplicate).toBe(true);
        const afterPublish = await getJob(claim!.jobId);
        expect(afterPublish.stage, JSON.stringify(bridge.requests)).toBe("verify");
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
      vi.stubEnv("INTERNAL_API_TOKEN", "task7-local-worker-token"); vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1"); vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
      vi.stubEnv("HARMONIA_CONNECTION_ENVELOPE_KEY_RAW", "0123456789abcdefghijklmnopqrstuv");
      const bridge = await campaignWorkerBridge();
      await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 4, maxItemsPerWeek: 4 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
      await approveInitialStrategy(bridge);
      const draft = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "Urgently draft a standalone founder update; do not add it to a campaign.", advice: { action: "create_job", disposition: "independent", expectedOutcome: "Address an urgent founder question", requestedOutputs: ["x_post"], sourceHandles: [] } });
      const planned = await materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
      expect(planned.campaignRef).toBeNull();
      const [first, second] = await Promise.all([claimNextPlannedItem(planned.planRef.id), claimNextPlannedItem(planned.planRef.id)]);
      expect(first?.jobId).toBeTruthy();
      expect(second?.jobId).toBe(first?.jobId);
      expect((await awsRepository().query(partition(`workspaces/${currentScope.workspaceId}/stage_outbox`))).rows.filter((row) => row.value?.jobId === first?.jobId)).toHaveLength(1);
      await bridge.close(); vi.unstubAllEnvs();
    });
  });

  it("retains knowledge without dispatch, blocks revoked source proposals, and quarantines an unknown provider outcome", async () => {
    currentScope = tenant();
    await runWithTenant(currentScope, async () => {
      vi.stubEnv("INTERNAL_API_TOKEN", "task7-local-worker-token"); vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1"); vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
      vi.stubEnv("HARMONIA_CONNECTION_ENVELOPE_KEY_RAW", "0123456789abcdefghijklmnopqrstuv");
      const bridge = await campaignWorkerBridge();
      await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 4, maxItemsPerWeek: 4 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
      const strategyRef = await approveInitialStrategy(bridge);
      const attachmentId = `knowledge-${randomUUID()}`;
      const knowledgeBytes = Buffer.from("Operator-authorized local research: founders want calmer workflow reviews.");
      await saveChatAttachment({ id: attachmentId, workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, createdByUserId: "operator", filename: "research.txt", mime: "text/plain", category: "document", sizeBytes: knowledgeBytes.byteLength, objectName: `local/${attachmentId}`, storageUri: `s3://local/${attachmentId}`, sha256: (await import("node:crypto")).createHash("sha256").update(knowledgeBytes).digest("hex"), malwareScan: { verdict: "clean", engine: "local-input-fixture", definitionVersion: "local", scannedBytes: knowledgeBytes.byteLength, scannedAt: new Date().toISOString() }, state: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const knowledge = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "I confirm I have rights to use this source. Keep this local research upload as knowledge only.", advice: { action: "create_job", disposition: "knowledge_only", expectedOutcome: "Retain source context", requestedOutputs: [], sourceHandles: [{ kind: "upload", attachmentId }] } });
      expect(knowledge.state).toBe("retained");
      expect((await executeIntakeDraft(knowledge)).jobId).toBeUndefined();
      const knowledgeRightsId = knowledge.sourceRights[intakeSourceKey({ kind: "upload", attachmentId })];
      const retainedRows = await awsRepository().query(partition(`workspaces/${currentScope.workspaceId}/brands/${currentScope.brandId}/sources`));
      const retainedSource = retainedRows.rows.find(row => row.value?.providerResourceId === attachmentId)!;
      const knowledgeDigest = (await import("node:crypto")).createHash("sha256").update(knowledgeBytes).digest("hex");
      expect(retainedSource.value).toMatchObject({ state: "ready", contentDigest: knowledgeDigest, rightsAuthorizationId: knowledgeRightsId });
      expect((await awsRepository().read(recordKey(`workspaces/${currentScope.workspaceId}/brands/${currentScope.brandId}/source_payloads/${retainedSource.id}`))).value).toMatchObject({
        workspaceId: currentScope.workspaceId,
        brandId: currentScope.brandId,
        sourceId: retainedSource.id,
        intakeDraftId: knowledge.id,
        attachmentDigest: knowledgeDigest,
        input: { attachmentId, rightsAuthorizationId: knowledgeRightsId },
      });

      const mixedAttachmentId = `mixed-knowledge-${randomUUID()}`;
      const mixedBytes = Buffer.from("A second local source remains authoritative even beside an unretrieved remote reference.");
      const mixedDigest = (await import("node:crypto")).createHash("sha256").update(mixedBytes).digest("hex");
      await saveChatAttachment({ id: mixedAttachmentId, workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, createdByUserId: "operator", filename: "mixed-research.txt", mime: "text/plain", category: "document", sizeBytes: mixedBytes.byteLength, objectName: `local/${mixedAttachmentId}`, storageUri: `s3://local/${mixedAttachmentId}`, sha256: mixedDigest, malwareScan: { verdict: "clean", engine: "local-input-fixture", definitionVersion: "local", scannedBytes: mixedBytes.byteLength, scannedAt: new Date().toISOString() }, state: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const remoteUrl = "https://example.com/unretrieved-knowledge";
      const mixed = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "I confirm I have rights to use this source. Retain this uploaded research with the remote reference as knowledge only.", advice: { action: "create_job", disposition: "knowledge_only", expectedOutcome: "Retain mixed source context", requestedOutputs: [], sourceHandles: [{ kind: "web", url: remoteUrl }, { kind: "upload", attachmentId: mixedAttachmentId }] } });
      expect((await executeIntakeDraft(mixed)).jobId).toBeUndefined();
      const mixedRightsId = mixed.sourceRights[intakeSourceKey({ kind: "upload", attachmentId: mixedAttachmentId })];
      const mixedRows = await awsRepository().query(partition(`workspaces/${currentScope.workspaceId}/brands/${currentScope.brandId}/sources`));
      const mixedSource = mixedRows.rows.find(row => row.value?.providerResourceId === mixedAttachmentId)!;
      expect(mixedSource.value).toMatchObject({ state: "ready", contentDigest: mixedDigest, rightsAuthorizationId: mixedRightsId });
      expect(mixed.sourceHandles).toContainEqual({ kind: "web", url: remoteUrl });
      expect(mixedRows.rows.find(row => row.value?.providerResourceId === remoteUrl)).toBeUndefined();
      const proposals = await import("@/lib/learning/proposals");
      const sourceId = retainedSource.id;
      const discovery = await proposals.recordSourceDiscovery(sourceId);
      const rejected = await proposals.createStrategyChangeProposal({ requestId: "reject-source", baseStrategyRef: strategyRef, changes: [{ type: "cadence_guidance", value: "Review weekly" }], rationale: "Source discovery needs a human strategy decision", evidenceRefs: [{ id: discovery.id, digest: discovery.digest }], contradictionRefs: [] });
      expect((await proposals.decideStrategyChange({ id: rejected.id, revision: rejected.revision, digest: rejected.digest, decision: "rejected", feedback: "Not enough evidence" })).status).toBe("rejected");
      const feedback = await proposals.recordOperatorFeedback({ requestId: "approved-feedback", text: "Use a clear invitation CTA.", sourceIds: [] });
      const approved = await proposals.createStrategyChangeProposal({ requestId: "approve-feedback", baseStrategyRef: strategyRef, changes: [{ type: "cta_guidance", value: ["Invite founders to share their workflow"] }], rationale: "Separate operator-approved change", evidenceRefs: [{ id: feedback.id, digest: feedback.digest }], contradictionRefs: [] });
      expect((await proposals.decideStrategyChange({ id: approved.id, revision: approved.revision, digest: approved.digest, decision: "approved" })).approvedStrategyRef?.revision).toBe(strategyRef.revision + 1);
      const revoked = await proposals.createStrategyChangeProposal({ requestId: "revoked-source", baseStrategyRef: await readActiveStrategyRef() as NonNullable<typeof strategyRef>, changes: [{ type: "cadence_guidance", value: "Review monthly" }], rationale: "This proposal must become unavailable after source withdrawal", evidenceRefs: [{ id: discovery.id, digest: discovery.digest }], contradictionRefs: [] });
      const { revokeSourceKnowledge } = await import("@/lib/sourceKnowledgeErasure");
      await revokeSourceKnowledge(sourceId);
      await expect(proposals.decideStrategyChange({ id: revoked.id, revision: revoked.revision, digest: revoked.digest, decision: "approved" })).rejects.toThrow(/revoked|unavailable/);

      const jobId = `unknown-${randomUUID()}`;
      await saveConnection({ platform: "x", mode: "manual", accessToken: "local-not-used", connectedAt: new Date().toISOString(), health: "active" });
      const action: PlannedAction = { id: "publish", jobId, type: "publish_x_post", title: "Publish", description: "", risk: "high", requiresApproval: true, approvalState: "pending", payload: { text: "A locally quarantined outcome" }, state: "planned" };
      await awsRepository().put(recordKey(`workspaces/${currentScope.workspaceId}/jobs/${jobId}`), { workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, createdByUserId: "operator", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stage: "awaiting_approval", status: "waiting_for_approval", config: { platforms: ["x"] }, actions: [action] });
      const { materializeExecutableJobCommands } = await import("@/lib/jobEffectCommands");
      const { recordApproval, transitionStageWithOutbox } = await import("@/lib/repository");
      await operatorDecision(() => recordApproval(jobId, action.id, "approved", actionPayloadDigest(action), { actorType: "cognito_operator", actorSubjectId: "operator", authenticationId: "local-acceptance", channel: "dashboard" }));
      await materializeExecutableJobCommands(jobId);
      await transitionStageWithOutbox(jobId, "awaiting_approval", "publish", "local controlled provider loss");
      const unknownBridge = await campaignWorkerBridge({ loseProviderResponse: true });
      try {
        const attempted = await nextStage(unknownBridge, jobId, "publish");
        expect((attempted.result.result as { failed?: boolean }).failed).toBe(true);
      } finally { await unknownBridge.close(); }
      const commands = await import("@/lib/effectCommandStore");
      const command = (await commands.listCommandsForJob(jobId))[0]!;
      expect(await getCommand(command.id), JSON.stringify(unknownBridge.requests)).toMatchObject({ state: "unknown", unknownReason: expect.stringContaining("local controlled provider response loss") });
      await expect(commands.claimCommandEffect(command.id, { operationId: `job:${jobId}:effect:${command.id}`, traceId: "c".repeat(32), claimToken: "must-not-replay" })).rejects.toThrow("effect command is unknown");
      await bridge.close(); vi.unstubAllEnvs();
    });
  });

  it("fences missing, revoked, mismatched, and stale knowledge authority before retention", async () => {
    currentScope = tenant();
    await runWithTenant(currentScope, async () => {
      const createKnowledgeDraft = async (label: string) => {
        const attachmentId = `${label}-${randomUUID()}`;
        const bytes = Buffer.from(`Locally authorized knowledge authority fixture: ${label}`);
        const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
        await saveChatAttachment({ id: attachmentId, workspaceId: currentScope.workspaceId, brandId: currentScope.brandId, createdByUserId: "operator", filename: `${label}.txt`, mime: "text/plain", category: "document", sizeBytes: bytes.byteLength, objectName: `local/${attachmentId}`, storageUri: `s3://local/${attachmentId}`, sha256, malwareScan: { verdict: "clean", engine: "local-input-fixture", definitionVersion: "local", scannedBytes: bytes.byteLength, scannedAt: new Date().toISOString() }, state: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const draft = await submitIntakeTurn({ requestId: randomUUID(), conversationId: randomUUID(), surface: "dashboard", message: "I confirm I have rights to use this source. Retain this local upload as knowledge only.", advice: { action: "create_job", disposition: "knowledge_only", expectedOutcome: `Retain ${label}`, requestedOutputs: [], sourceHandles: [{ kind: "upload", attachmentId }] } });
        const source = { kind: "upload" as const, attachmentId };
        return { attachmentId, draft, sha256, rightsId: draft.sourceRights[intakeSourceKey(source)] };
      };
      const root = `workspaces/${currentScope.workspaceId}/brands/${currentScope.brandId}`;

      const revoked = await createKnowledgeDraft("revoked");
      await awsRepository().patch(recordKey(`${root}/source_rights/${revoked.rightsId}`), { revokedAt: new Date().toISOString() });
      await expect(executeIntakeDraft(revoked.draft)).rejects.toThrow("source rights authorization revoked");

      const missing = await createKnowledgeDraft("missing");
      await awsRepository().remove(recordKey(`${root}/source_rights/${missing.rightsId}`));
      await expect(executeIntakeDraft(missing.draft)).rejects.toThrow("source rights authorization missing");

      const mismatched = await createKnowledgeDraft("mismatched");
      await awsRepository().patch(recordKey(`${root}/source_rights/${mismatched.rightsId}`), { sourceHandleDigest: "0".repeat(64) });
      await expect(executeIntakeDraft(mismatched.draft)).rejects.toThrow("source rights binding mismatch");

      const stale = await createKnowledgeDraft("stale");
      await executeIntakeDraft(stale.draft);
      await awsRepository().patch(recordKey(`workspaces/${currentScope.workspaceId}/chat_attachments/${stale.attachmentId}`), { sha256: "f".repeat(64), updatedAt: new Date().toISOString() });
      await expect(executeIntakeDraft(stale.draft)).rejects.toThrow("retained knowledge source no longer matches intake authority");

      for (const [label, sha256] of [["short", "abc"], ["nonhex", "g".repeat(64)], ["uppercase", "A".repeat(64)]] as const) {
        const malformed = await createKnowledgeDraft(`malformed-${label}`);
        await awsRepository().patch(recordKey(`workspaces/${currentScope.workspaceId}/chat_attachments/${malformed.attachmentId}`), { sha256, updatedAt: new Date().toISOString() });
        await expect(executeIntakeDraft(malformed.draft)).rejects.toThrow("knowledge attachment authority is incomplete");
      }

      const retainedForReplay = async (label: string) => {
        const replay = await createKnowledgeDraft(`replay-${label}`);
        await executeIntakeDraft(replay.draft);
        const row = (await awsRepository().query(partition(`${root}/sources`))).rows.find(candidate => candidate.value?.providerResourceId === replay.attachmentId)!;
        return { ...replay, sourceId: row.id };
      };
      const corruptedSourceId = await retainedForReplay("source-id");
      await awsRepository().patch(recordKey(`${root}/sources/${corruptedSourceId.sourceId}`), { id: "corrupted-source-id" });
      await expect(executeIntakeDraft(corruptedSourceId.draft)).rejects.toThrow("retained knowledge source no longer matches intake authority");

      const corruptedState = await retainedForReplay("source-state");
      await awsRepository().patch(recordKey(`${root}/sources/${corruptedState.sourceId}`), { state: "discovered" });
      await expect(executeIntakeDraft(corruptedState.draft)).rejects.toThrow("retained knowledge source no longer matches intake authority");

      const corruptedPayloadScope = await retainedForReplay("payload-scope");
      await awsRepository().patch(recordKey(`${root}/source_payloads/${corruptedPayloadScope.sourceId}`), { workspaceId: "other-workspace", brandId: "other-brand" });
      await expect(executeIntakeDraft(corruptedPayloadScope.draft)).rejects.toThrow("retained knowledge source no longer matches intake authority");

      const corruptedPayloadLink = await retainedForReplay("payload-link");
      await awsRepository().patch(recordKey(`${root}/source_payloads/${corruptedPayloadLink.sourceId}`), { sourceId: "other-source", intakeDraftId: "other-draft" });
      await expect(executeIntakeDraft(corruptedPayloadLink.draft)).rejects.toThrow("retained knowledge source no longer matches intake authority");
      const retained = await awsRepository().query(partition(`${root}/sources`));
      expect(retained.rows.filter(row => [revoked.attachmentId, missing.attachmentId, mismatched.attachmentId].includes(String(row.value?.providerResourceId)))).toHaveLength(0);
      expect(retained.rows.find(row => row.value?.providerResourceId === stale.attachmentId)?.value).toMatchObject({ contentDigest: stale.sha256, rightsAuthorizationId: stale.rightsId });
    });
  }, 60_000);
});
