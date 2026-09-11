import { awsRepository, recordKey, UnknownCommitOutcome, type DynamoTransaction } from "../dynamo";
import { currentTenant } from "../tenancy";
import { authorityKey, currentPlan, listPlanningAssets, readItemState, readPlannedItem, readPlanningPolicy } from "../campaigns/repository";
import { readActiveStrategyRef } from "../strategy/repository";
import { strategyDigest } from "../strategyApproval";
import { calendarConflicts, plannedCalendar } from "./commands";
import { insertExecutionJob, retryFailedJobWithOutbox } from "../repository";
import { proposeOutputPlan, sealOutputPlan } from "../outputPlanning";
import { OUTPUT_CAPABILITIES } from "../outputCapabilities";
import { sealManifest } from "../sourceRegistry";
import type { JobConfig, JobSourceManifest } from "../types";
import type { AuthorityRef, PlannedItem, PlannedItemState } from "../campaigns/contracts";
import { readPlannedExecutionAuthority } from "./executionAuthority";

export async function plannedItemAdmission(tx: DynamoTransaction, item: PlannedItem, asOf: string): Promise<string[]> {
  const plan = await currentPlan(item.planRef.id, tx); const policy = await readPlanningPolicy(tx);
  const active = await readActiveStrategyRef(tx); const assets = await listPlanningAssets(tx); const calendar = await plannedCalendar(tx);
  const state = await readItemState(item.ref, tx);
  const reasons = calendarConflicts(item, calendar, policy);
  if (!plan.itemRefs.some(ref => strategyDigest(ref) === strategyDigest(item.ref))) reasons.push("planned item binding is no longer current");
  if (calendar.filter(other => other.ref.id !== item.ref.id && ["running", "awaiting_approval"].includes(other.lifecycle.status)).length >= policy.maxConcurrentItems) reasons.push("production concurrency occupied");
  if (Date.parse(item.productionReadyAt ?? item.scheduledFor) > Date.parse(asOf)) reasons.push("production schedule is not due");
  if (strategyDigest(active) !== strategyDigest(item.strategyRef)) reasons.push("active strategy changed; plan approval required");
  for (const ref of item.dependencies) { const dependency = await readItemState(ref, tx); if (dependency.status !== "completed") reasons.push(`dependency ${ref.id} is ${dependency.status}`); }
  for (const assetId of item.requiredAssetIds) if (assets.find(asset => asset.id === assetId)?.status !== "ready") reasons.push(`asset ${assetId} is not ready`);
  if (item.evidence.mode === "operator_context" && item.requestedOutputs.some(output => !["x_post", "linkedin_post", "caption", "social_image", "generated_video", "generated_music", "content_pack"].includes(output))) reasons.push("selected output requires factual source evidence");
  if (state.dispositionProposalId) reasons.push(`execution disposition required: ${state.dispositionProposalId}`);
  if (["completed", "cancelled", "requires_disposition"].includes(state.status)) reasons.push(`planned item is ${state.status}`);
  const execution = await readPlannedExecutionAuthority(tx, item, state);
  if (execution.unknown) reasons.push("unknown effect outcome requires reconciliation");
  if (execution.claimed && !state.jobId) reasons.push("execution authority lacks its item binding; reconciliation required");
  return reasons;
}

export type PlannedClaim = { itemRef: AuthorityRef; jobId: string; outboxId: string };
export async function claimNextPlannedItem(planId: string, asOf = new Date().toISOString()): Promise<PlannedClaim | null> {
  try { return await awsRepository().atomic(tx => claimNextInTransaction(tx, planId, asOf)); }
  catch (error) {
    if (!(error instanceof UnknownCommitOutcome) && !/record already exists|planned execution already exists/.test(String(error))) throw error;
    const plan = await currentPlan(planId);
    for (const ref of plan.itemRefs) {
      const state = await readItemState(ref);
      if (state.jobId && state.outboxId && state.status === "running") {
        const job = await awsRepository().read(recordKey(`workspaces/${ref.workspaceId}/jobs/${state.jobId}`));
        const outbox = await awsRepository().read(recordKey(`workspaces/${ref.workspaceId}/stage_outbox/${state.outboxId}`));
        if (job.present && strategyDigest(job.value?.plannedItemRef) === strategyDigest(ref) && outbox.value?.jobId === state.jobId && outbox.value?.brandId === ref.brandId) return { itemRef: ref, jobId: state.jobId, outboxId: state.outboxId };
      }
    }
    throw error;
  }
}
export async function claimNextInTransaction(tx: DynamoTransaction, planId: string, asOf: string, itemId?: string): Promise<PlannedClaim | null> {
  const plan = await currentPlan(planId, tx); const policy = await readPlanningPolicy(tx);
  const all = await plannedCalendar(tx);
  const running = all.filter(item => ["running", "awaiting_approval"].includes(item.lifecycle.status)).map(item => item.lifecycle);
  const own = running.find(state => (!itemId || state.ref.id === itemId) && plan.itemRefs.some(ref => strategyDigest(ref) === strategyDigest(state.ref)));
  if (own?.jobId && own.outboxId) return { itemRef: own.ref, jobId: own.jobId, outboxId: own.outboxId };
  if (running.length >= policy.maxConcurrentItems) return null;
  const items = all.filter(item => (!itemId || item.ref.id === itemId) && plan.itemRefs.some(ref => strategyDigest(ref) === strategyDigest(item.ref)));
  for (const item of items.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.ref.id.localeCompare(b.ref.id))) {
    const state = item.lifecycle;
    if (!["planned", "blocked"].includes(state.status) || state.jobId) continue;
    if (Date.parse(item.productionReadyAt ?? item.scheduledFor) > Date.parse(asOf)) continue;
    const reasons = await plannedItemAdmission(tx, item, asOf);
    if (reasons.length) { tx.put(authorityKey("planned_item_states", item.ref), { ...state, status: "blocked", reason: reasons.join("; "), updatedAt: asOf }); continue; }
    const jobId = `planned-${strategyDigest(item.ref).slice(0, 56)}`;
    const editorial = item.productionContext.mode === "source_backed" ? item.productionContext : null;
    const config: JobConfig = {
      operatorBrief: item.operatorBrief, desiredOutputs: item.requestedOutputs, allowedOutputs: item.requestedOutputs, platforms: [item.channel],
      ...(editorial ? { ...editorial.config, operatorBrief: item.operatorBrief, desiredOutputs: item.requestedOutputs, allowedOutputs: item.requestedOutputs } : {}),
    };
    if (item.evidence.mode === "source_backed") {
      const row = await tx.read(recordKey(`workspaces/${item.workspaceId}/jobs/${item.evidence.sourceJobId}/source_manifests/${config.sourceManifestId}`));
      if (!row.present) throw new Error("planned source manifest authority missing");
      const original = row.value as unknown as JobSourceManifest;
      const manifest = sealManifest({ ...original, jobId, id: `manifest-${strategyDigest(item.ref).slice(0, 48)}`, sealedAt: asOf });
      config.sourceManifestId = manifest.id;
      tx.insert(recordKey(`workspaces/${item.workspaceId}/jobs/${jobId}/source_manifests/${manifest.id}`), manifest);
    }
    const outputPlan = editorial ? proposeOutputPlan(jobId, item.requestedOutputs, item.requestedOutputs, editorial.sourceAnalysis) : sealOutputPlan({ id: `output-plan-${jobId}`, desiredOutputs: item.requestedOutputs, allowedOutputs: item.requestedOutputs, outputs: item.requestedOutputs.map((outputType, index) => ({ id: `output-${index + 1}-${outputType}`, outputType, quantity: 1, destinations: OUTPUT_CAPABILITIES[outputType].publisher ? [OUTPUT_CAPABILITIES[outputType].publisher!] : [], evidenceRefs: [], costClass: OUTPUT_CAPABILITIES[outputType].costClass, approvalClass: OUTPUT_CAPABILITIES[outputType].approvalClass })) });
    const job = await insertExecutionJob(tx, jobId, config, "draft", { strategyRef: item.strategyRef, plannedItemRef: item.ref, planRef: item.planRef, campaignOutputPlan: outputPlan,
      ...(item.evidence.mode === "operator_context" ? { operatorPlanningContext: item.evidence } : {}),
      ...(editorial ? { sourceAnalysis: editorial.sourceAnalysis } : {}),
    });
    const next: PlannedItemState = { ...state, status: "running", jobId, outboxId: job.outboxId, updatedAt: asOf };
    tx.put(authorityKey("planned_item_states", item.ref), next);
    return { itemRef: item.ref, jobId, outboxId: job.outboxId };
  }
  return null;
}
/** Called only with persisted terminal job authority, including during restart recovery. */
export async function reconcilePlannedExecution(jobId: string): Promise<void> {
  let planId: string | undefined;
  await awsRepository().atomic(async tx => {
    const row = await tx.read(recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${jobId}`));
    if (!row.present || row.value?.brandId !== currentTenant().brandId) throw new Error("execution job not found");
    const ref = row.value!.plannedItemRef as AuthorityRef | undefined; if (!ref) return;
    const item = await readPlannedItem(ref, tx); const state = await readItemState(ref, tx);
    if (state.jobId !== jobId) throw new Error("planned execution binding mismatch");
    const job = row.value!;
    const status = job.controlState === "cancelled" ? "cancelled" : job.failure || job.status === "failed" ? "failed" : job.stage === "complete" ? job.terminalOutcome === "succeeded" ? "completed" : "blocked" : job.stage === "awaiting_approval" ? "awaiting_approval" : "running";
    tx.put(authorityKey("planned_item_states", ref), { ...state, status, reason: state.retryPending || state.dispositionProposalId ? state.reason : status === "blocked" ? `execution outcome ${job.terminalOutcome}` : "", updatedAt: new Date().toISOString(), retryable: Boolean((job.failure as { retryable?: boolean })?.retryable) });
    if (status === "completed") planId = item.planRef.id;
  });
  if (planId) {
    const { scheduleCompletedJob } = await import("../learning/repository");
    await scheduleCompletedJob(jobId);
    await resumePendingPlannedRetries(); await claimNextPlannedItem(planId);
  }
}
export async function resumePendingPlannedRetries() {
  for (const item of await plannedCalendar()) if (item.lifecycle.retryPending && item.lifecycle.jobId) {
    const row = await awsRepository().read(recordKey(`workspaces/${item.workspaceId}/jobs/${item.lifecycle.jobId}`));
    const failure = row.value?.failure as { stage: import("../types").Stage; retryable: boolean } | undefined;
    if (item.lifecycle.permanentRetryAuthorizationId) await retryFailedJobWithOutbox(item.lifecycle.jobId, null, { permanentAuthorizationId: item.lifecycle.permanentRetryAuthorizationId });
    else if (failure?.retryable) await retryFailedJobWithOutbox(item.lifecycle.jobId, failure.stage);
  }
}
export async function recoverPlannedWork() {
  const { listCurrentPlans } = await import("../campaigns/repository");
  const plans = await listCurrentPlans();
  await resumePendingPlannedRetries();
  for (const plan of plans) {
    for (const ref of plan.itemRefs) { const state = await readItemState(ref); if (state.jobId && state.status !== "completed") await reconcilePlannedExecution(state.jobId); }
    await claimNextPlannedItem(plan.ref.id);
  }
}
