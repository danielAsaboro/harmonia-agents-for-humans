import { randomBytes } from "node:crypto";
import { z } from "zod";
import { awsRepository, partition, recordKey, type DynamoTransaction } from "../dynamo";
import { assertResourceWorkspace, currentTenant, tenantSubjectId } from "../tenancy";
import { requireContentOperator } from "../authority";
import { applyReservation, applyReleasedReservation, microsToUsd, canReserve, exceedsApprovalThreshold, usdToMicros } from "../costs";
import { parseBudgetConfig } from "../config";
import { campaignRoot, readItemState, readPlannedItem, readRequired } from "../campaigns/repository";
import { strategyDigest } from "../strategyApproval";
import type { StrategyReader } from "../strategy/repository";
import { priorInsightsFromJob } from "../repository";
import type { Job, JobBudget, PlannedAction, Receipt, VerificationResult } from "../types";
import { observationKey, observationValueSchema, providerObservationInputSchema, type Collection, type ObservationValue, type PerformanceObservation } from "./contracts";
import { evaluateObservations } from "./evaluation";

export const learningKey = (collection: string, id: string) => { if (!/^[A-Za-z0-9_.:-]{1,180}$/.test(id)) throw new Error("invalid learning authority id"); return recordKey(`${campaignRoot()}/${collection}/${id}`); };
export class InvalidLearningEvidence extends Error {}
type LearningJob = Job & { actions: PlannedAction[]; verifications: VerificationResult[] };
const jobKey = (id: string) => { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("invalid job id"); return recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${id}`); };
export async function assertLearningSources(sourceIds: string[], reader: StrategyReader = awsRepository()) {
  for (const sourceId of sourceIds) {
    const source = await readRequired<{ workspaceId: string; brandId: string; state: string }>(learningKey("sources", sourceId), reader);
    if (source.state !== "ready") throw new InvalidLearningEvidence("learning evidence source revoked or unavailable");
  }
}
export async function validBinding(collection: Collection, reader: StrategyReader) {
  assertResourceWorkspace(currentTenant(), collection);
  const item = await readPlannedItem(collection.itemRef, reader); const state = await readItemState(item.ref, reader);
  if (state.jobId !== collection.jobId || state.status !== "completed" || !item.measurements.some(m => strategyDigest(m) === strategyDigest(collection.measurement))) throw new InvalidLearningEvidence("observation item/job/measurement binding changed");
  const tombstone = await reader.read(recordKey(`workspaces/${currentTenant().workspaceId}/deletion_tombstones/${collection.jobId}`));
  if (tombstone.present) throw new InvalidLearningEvidence("learning job evidence revoked");
  const job = await readRequired<LearningJob>(jobKey(collection.jobId), reader);
  if (strategyDigest(job.plannedItemRef) !== strategyDigest(item.ref) || strategyDigest(job.strategyRef) !== strategyDigest(collection.strategyRef)) throw new InvalidLearningEvidence("observation strategy binding changed");
  if (collection.measurement.definition.collectionMethod === "official_x" && collection.postId) {
    const verification = job.verifications?.find(v => v.verified && v.method === "official_api_readback" && v.actionId === collection.actionId && v.target === `x:${collection.postId}` && v.evidence?.digest && v.evidence?.url);
    if (!verification || !job.actions?.some(a => a.id === collection.actionId && a.type === "publish_x_post" && a.state === "executed")) throw new InvalidLearningEvidence("publication verification authority withdrawn");
    // Effect receipts are scoped by the already-authorized job's child partition.
    const row = await reader.read(recordKey(`${jobKey(collection.jobId).path}/receipts/${verification.receiptId}`));
    const receipt = row.value as unknown as Receipt | undefined;
    if (!receipt || receipt.jobId !== collection.jobId || receipt.actionId !== collection.actionId || receipt.actionType !== "publish_x_post" || !["applied", "already_applied"].includes(receipt.outcome) || Date.parse(receipt.performedAt) !== Date.parse(collection.window.startAt)) throw new InvalidLearningEvidence("publication effect receipt binding changed");
  }
  await assertLearningSources(collection.sourceIds, reader); return job;
}
export async function readObservation(id: string, reader: StrategyReader = awsRepository()): Promise<PerformanceObservation> {
  const observation = await readRequired<PerformanceObservation>(learningKey("performance_observations", id), reader);
  const { digest, ...body } = observation;
  if (strategyDigest(body) !== digest) throw new Error("observation authority digest mismatch");
  return observation;
}
export async function assertObservationUsable(observation: PerformanceObservation, reader: StrategyReader = awsRepository(), requireAvailable = true) {
  if (observation.availability === "revoked" || (requireAvailable && observation.availability !== "available")) throw new InvalidLearningEvidence("observation evidence unavailable or revoked");
  const collection = await readRequired<Collection>(learningKey("observation_outbox", observation.collectionId), reader);
  await validBinding(collection, reader);
  const current = await readObservation(collection.observationId, reader);
  if (current.availability === "revoked" || (requireAvailable && collection.state !== "completed")) throw new InvalidLearningEvidence("observation revoked or unresolved");
  let successor = current;
  const visited = new Set<string>();
  while (true) {
    if (successor.collectionId !== collection.id || visited.has(successor.id)) throw new InvalidLearningEvidence("observation lineage mismatch");
    visited.add(successor.id);
    const lineage = await readRequired<{ observation: { id: string; digest: string }; previous: { id: string; digest: string } | null }>(learningKey("observation_lineage", successor.id), reader);
    if (lineage.observation.id !== successor.id || lineage.observation.digest !== successor.digest) throw new InvalidLearningEvidence("observation lineage digest mismatch");
    if (successor.id === observation.id) break;
    if (!lineage.previous) throw new InvalidLearningEvidence("observation is not an authorized historical cohort member");
    successor = await readObservation(lineage.previous.id, reader);
    if (successor.digest !== lineage.previous.digest) throw new InvalidLearningEvidence("historical observation digest mismatch");
  }
}
export function buildObservation(collection: Collection, result: ObservationValue, now: string, attribution: { provider: PerformanceObservation["provider"]; actor?: string; evidenceRefs?: string[] }): PerformanceObservation {
  observationValueSchema.parse(result);
  const id = `observation-${strategyDigest({ collectionId: collection.id, result, now, attribution }).slice(0, 48)}`;
  const body = { id, collectionId: collection.id, workspaceId: collection.workspaceId, brandId: collection.brandId, itemRef: collection.itemRef, planRef: collection.planRef, campaignRef: collection.campaignRef, strategyRef: collection.strategyRef, pillar: collection.pillar, jobId: collection.jobId, actionId: collection.actionId, artifactId: collection.artifactId, postId: collection.postId, sourceIds: collection.sourceIds, measurement: collection.measurement, kind: collection.measurement.definition.kind, window: collection.window, observedAt: now, ...result, provider: attribution.provider, actor: attribution.actor ?? null, evidenceRefs: attribution.evidenceRefs ?? [] };
  return { ...body, digest: strategyDigest(body) };
}
export async function insertObservation(tx: DynamoTransaction, observation: PerformanceObservation) {
  const key = learningKey("performance_observations", observation.id), old = await tx.read(key);
  if (old.present) { if (old.value?.digest !== observation.digest) throw new Error("observation identity reused"); return; }
  const collection = await tx.read(learningKey("observation_outbox", observation.collectionId));
  const previous = collection.present ? await readObservation(String(collection.value!.observationId), tx) : null;
  tx.insert(key, observation);
  tx.insert(learningKey("observation_lineage", observation.id), { workspaceId: observation.workspaceId, brandId: observation.brandId, collectionId: observation.collectionId, observation: { id: observation.id, digest: observation.digest }, previous: previous ? { id: previous.id, digest: previous.digest } : null });
}
/** Recovery calls this for completed items. Definition, anchor and provider target are frozen once. */
export async function scheduleCompletedJob(jobId: string, now = new Date().toISOString()): Promise<Collection[]> {
  const tombstone = await awsRepository().read(recordKey(`workspaces/${currentTenant().workspaceId}/deletion_tombstones/${jobId}`));
  if (tombstone.present) {
    assertResourceWorkspace(currentTenant(), tombstone.value as { workspaceId: string; brandId: string });
    await revokeLearningObservations({ jobId }, "Job evidence erased");
    await awsRepository().atomic(async tx => {
      const key = learningKey("learning_erasure_receipts", jobId);
      if (!(await tx.read(key)).present) tx.insert(key, { workspaceId: currentTenant().workspaceId, brandId: currentTenant().brandId, jobId, availability: "revoked", value: null, reason: "Job evidence erased", tombstoneDigest: strategyDigest(tombstone.value), checkedAt: now });
    });
    return [];
  }
  return awsRepository().atomic(async tx => {
    const job = await readRequired<LearningJob>(jobKey(jobId), tx);
    if (!job.plannedItemRef) return [];
    const item = await readPlannedItem(job.plannedItemRef, tx), state = await readItemState(item.ref, tx);
    if (state.status !== "completed" || state.jobId !== jobId || job.stage !== "complete" || job.terminalOutcome !== "succeeded") return [];
    const index = learningKey("measurement_schedules", strategyDigest(item.ref)); const existing = await tx.read(index);
    if (existing.present) return Promise.all((existing.value!.collectionIds as string[]).map(id => readRequired<Collection>(learningKey("observation_outbox", id), tx)));
    const receiptRows = await tx.read(partition(`${jobKey(jobId).path}/receipts`));
    const receipts = receiptRows.rows.map(row => row.value as unknown as Receipt);
    const verifies = (job.verifications ?? []).filter(v => v.verified && v.evidence?.digest && v.evidence?.url && Number.isFinite(Date.parse(v.checkedAt)));
    const published = verifies.filter(v => v.method === "official_api_readback" && /^x:[0-9]+$/.test(v.target) && job.actions?.some(a => a.id === v.actionId && a.type === "publish_x_post" && a.state === "executed"));
    const verification = published.length === 1 ? published[0] : undefined;
    const receipt = verification ? receipts.find(r => r.id === verification.receiptId && r.actionId === verification.actionId && ["applied", "already_applied"].includes(r.outcome)) : undefined;
    const manifestId = job.config.sourceManifestId;
    const manifest = manifestId ? await tx.read(recordKey(`${jobKey(jobId).path}/source_manifests/${manifestId}`)) : null;
    const sourceIds = (manifest?.value?.directSourceIds as string[] | undefined) ?? [];
    const result: Collection[] = [];
    for (const measurement of item.measurements) {
      const m = measurement.definition, delivery = m.kind === "delivery_verification";
      const anchor = m.window.anchor === "publication" ? receipt?.performedAt : job.updatedAt;
      const start = anchor && Number.isFinite(Date.parse(anchor)) ? anchor : now;
      const endAt = new Date(Date.parse(start) + m.window.endOffsetSeconds * 1000).toISOString();
      const window = { startAt: new Date(Date.parse(start)).toISOString(), endAt };
      const id = observationKey(item.ref, measurement, window);
      const collection: Collection = { id, workspaceId: item.workspaceId, brandId: item.brandId, itemRef: item.ref, planRef: item.planRef, campaignRef: item.campaignRef, strategyRef: item.strategyRef, pillar: item.productionContext.mode === "source_backed" ? item.productionContext.item.contentPillar : null, jobId, actionId: delivery ? verifies.length === 1 ? verifies[0].actionId : null : verification?.actionId ?? null, postId: verification?.target.slice(2) ?? null, artifactId: delivery && verifies.length === 1 ? artifactIdFor(job, verifies[0]) : null, sourceIds, measurement, window, dueAt: endAt, expiresAt: new Date(Date.parse(endAt) + m.window.collectionToleranceSeconds * 1000).toISOString(), state: "scheduled", observationId: "pending", createdAt: now, attempts: 0 };
      let value: ObservationValue = { availability: "pending_window", value: null, reason: m.collectionMethod === "operator" ? "awaiting_attributed_operator_observation" : "observation_window_not_collected" };
      if (delivery) {
        const verifiedReceipts = verifies.filter(v => receipts.some(r => r.id === v.receiptId && r.actionId === v.actionId && ["applied", "already_applied"].includes(r.outcome)));
        value = verifiedReceipts.length ? { availability: "available", value: 1, reason: null } : { availability: "unavailable", value: null, reason: "no_verified_delivery_receipt" };
      } else if (m.collectionMethod === "unsupported") value = { availability: "unavailable", value: null, reason: "provider_metrics_not_integrated" };
      else if (m.window.anchor === "publication" && (!verification || !receipt)) value = { availability: "unavailable", value: null, reason: "no_verified_publication" };
      const observation = buildObservation(collection, value, now, { provider: "host", evidenceRefs: delivery && value.availability === "available" ? verifies.map(v => `verification:${jobId}:${v.id}`) : [] });
      collection.observationId = observation.id; if (value.availability !== "pending_window") collection.state = "completed";
      await insertObservation(tx, observation); tx.insert(learningKey("observation_outbox", id), collection); result.push(collection);
    }
    tx.insert(index, { workspaceId: item.workspaceId, brandId: item.brandId, collectionIds: result.map(c => c.id) }); return result;
  });
}
function artifactIdFor(job: LearningJob, verification: VerificationResult): string | null { const payload = job.actions?.find(a => a.id === verification.actionId)?.payload; return payload && "artifactId" in payload && typeof payload.artifactId === "string" ? payload.artifactId : null; }
export async function claimObservation(id: string, token: string, now = new Date().toISOString()): Promise<Collection | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("observation claim token required");
  return awsRepository().atomic(async tx => {
    const key = learningKey("observation_outbox", id), c = await readRequired<Collection>(key, tx);
    if (c.state === "completed" || c.state === "reconciliation_required" || Date.parse(now) < Date.parse(c.dueAt) || (c.state === "collecting" && Date.parse(c.leaseUntil!) > Date.parse(now))) return null;
    if (c.measurement.definition.collectionMethod !== "official_x") return null;
    const job = await validBinding(c, tx);
    if (c.state === "collecting") {
      if (!c.dispatch) await settleCollectionCost(tx, c, "released", now);
      const observation = buildObservation(c, { availability: c.dispatch ? "failed" : "unavailable", value: null, reason: c.dispatch ? "collector_response_unknown_requires_reconciliation" : "claim_expired_before_dispatch" }, now, { provider: "host" });
      if (c.dispatch) insertCollectionReceipt(tx, c, { collectionId: c.id, token: c.token!, checkedAt: now, metrics: null, outcome: "unknown", reason: "collector_lease_expired_after_dispatch" }, observation, now);
      await insertObservation(tx, observation); tx.put(key, { ...c, state: c.dispatch ? "reconciliation_required" : "completed", observationId: observation.id }); return null;
    }
    if (Date.parse(now) > Date.parse(c.expiresAt)) {
      const observation = buildObservation(c, { availability: "unavailable", value: null, reason: "observation_window_missed" }, now, { provider: "host" });
      await insertObservation(tx, observation); tx.put(key, { ...c, state: "completed", observationId: observation.id }); return null;
    }
    const maximumUsd = process.env.X_METRICS_MAX_READ_COST_USD;
    if (process.env.HARMONIA_X_METRICS_ENABLED !== "true" || !maximumUsd || !/^\d+\.\d{1,6}$/.test(maximumUsd) || usdToMicros(maximumUsd) <= BigInt(0) || !job.budget || exceedsApprovalThreshold(job.budget, maximumUsd)) {
      const observation = buildObservation(c, { availability: "unavailable", value: null, reason: "X_metrics_cost_authority_not_configured" }, now, { provider: "host" });
      await insertObservation(tx, observation); tx.put(key, { ...c, state: "completed", observationId: observation.id }); return null;
    }
    const reservationId = `metrics-${c.id}`;
    const costAuthorization: NonNullable<Collection["costAuthorization"]> = { maximumUsd, reservationId, accounting: "reserved_pending_provider_billing" };
    const workspaceKey = recordKey(`workspaces/${c.workspaceId}`), workspace = await tx.read(workspaceKey);
    const workspaceBudget = workspace.value?.budget as JobBudget | undefined ?? { estimatedUsd: "0.00", observedUsd: "0.00", reservedUsd: "0.00", limitUsd: parseBudgetConfig(process.env).DEFAULT_WORKSPACE_BUDGET_USD, approvalThresholdUsd: job.budget.approvalThresholdUsd };
    if (!workspace.present || !canReserve(workspaceBudget, maximumUsd) || !canReserve(job.budget, maximumUsd)) {
      const observation = buildObservation(c, { availability: "unavailable", value: null, reason: "metrics_budget_exceeded" }, now, { provider: "host" });
      await insertObservation(tx, observation); tx.put(key, { ...c, state: "completed", observationId: observation.id }); return null;
    }
    const budget = applyReservation(job.budget, maximumUsd);
    tx.patch(jobKey(c.jobId), { budget });
    tx.patch(workspaceKey, { budget: applyReservation(workspaceBudget, maximumUsd) });
    tx.insert(learningKey("observation_cost_reservations", reservationId), { workspaceId: c.workspaceId, brandId: c.brandId, jobId: c.jobId, collectionId: c.id, ...costAuthorization, state: "reserved", observedCostUsd: null, createdAt: now });
    const claimed: Collection = { ...c, state: "collecting", token, attempts: c.attempts + 1, costAuthorization, leaseUntil: new Date(Date.parse(now) + 60000).toISOString() }; tx.put(key, claimed); return claimed;
  });
}
export async function dueObservationCollections(now = new Date().toISOString()): Promise<Collection[]> {
  const rows = await awsRepository().query(partition(`${campaignRoot()}/observation_outbox`));
  return rows.rows.map(r => r.value as unknown as Collection).filter(c => (c.state === "scheduled" || (c.state === "collecting" && Date.parse(c.leaseUntil!) <= Date.parse(now))) && c.measurement.definition.collectionMethod === "official_x" && Date.parse(c.dueAt) <= Date.parse(now)).slice(0, 20);
}
export async function claimDueObservations() { for (const c of await dueObservationCollections()) { const claimed = await claimObservation(c.id, randomBytes(32).toString("hex")); if (claimed) return [claimed]; } return []; }

export async function settleCollectionCost(tx: DynamoTransaction, c: Collection, disposition: "released" | "settled", now: string) {
  if (!c.costAuthorization) return;
  const key = learningKey("observation_cost_reservations", c.costAuthorization.reservationId), row = await tx.read(key);
  if (!row.present || row.value?.state !== "reserved") return;
  for (const budgetKey of [jobKey(c.jobId), recordKey(`workspaces/${c.workspaceId}`)]) {
    const record = await tx.read(budgetKey); if (!record.present) continue; // Never recreate erased job/workspace authority.
    const budget = record.value?.budget as JobBudget;
    const next = applyReleasedReservation(budget, c.costAuthorization.maximumUsd);
    if (disposition === "settled") next.settledEstimatedUsd = microsToUsd(usdToMicros(budget.settledEstimatedUsd ?? "0.00") + usdToMicros(c.costAuthorization.maximumUsd));
    tx.patch(budgetKey, { budget: next });
  }
  tx.patch(key, { state: disposition, observedCostUsd: null, estimatedCostUsd: disposition === "settled" ? c.costAuthorization.maximumUsd : "0.00", provenance: disposition === "settled" ? "configured_upper_bound_estimate" : "confirmed_no_dispatch", settledAt: now });
}

async function cancelUndispatched(tx: DynamoTransaction, c: Collection, reason: string, now: string) {
  if (c.dispatch) throw new Error("dispatched collection requires reconciliation");
  await settleCollectionCost(tx, c, "released", now);
  const observation = buildObservation(c, { availability: "unavailable", value: null, reason }, now, { provider: "host" });
  await insertObservation(tx, observation); tx.put(learningKey("observation_outbox", c.id), { ...c, state: "completed", observationId: observation.id });
  return null;
}
/** Atomic one-shot permit immediately before the external read. Replays grant no authority. */
export async function authorizeObservationDispatch(id: string, token: string, now = new Date().toISOString()): Promise<Collection | null> {
  return awsRepository().atomic(async tx => {
    const c = await readRequired<Collection>(learningKey("observation_outbox", id), tx);
    if (c.token !== token || c.state !== "collecting" || c.dispatch) return null;
    if (Date.parse(now) >= Date.parse(c.leaseUntil!) || Date.parse(now) >= Date.parse(c.expiresAt)) return cancelUndispatched(tx, c, "claim_expired_before_dispatch", now);
    if (process.env.HARMONIA_X_METRICS_ENABLED !== "true" || process.env.X_METRICS_MAX_READ_COST_USD !== c.costAuthorization?.maximumUsd || c.measurement.definition.collectionMethod !== "official_x") return cancelUndispatched(tx, c, "provider_disabled_before_dispatch", now);
    try { await validBinding(c, tx); } catch { return cancelUndispatched(tx, c, "host_rejected_before_dispatch", now); }
    const permitExpiresAt = new Date(Math.min(Date.parse(c.expiresAt), Date.parse(now) + 60000)).toISOString();
    const dispatched = { ...c, leaseUntil: permitExpiresAt, dispatch: { token, issuedAt: now, expiresAt: permitExpiresAt } };
    tx.put(learningKey("observation_outbox", id), dispatched); return dispatched;
  });
}
export async function cancelObservationDispatch(id: string, token: string, reason: string, now = new Date().toISOString()) {
  return awsRepository().atomic(async tx => {
    const c = await readRequired<Collection>(learningKey("observation_outbox", id), tx);
    if (c.token !== token) throw new Error("stale observation claim");
    if (c.state === "completed" && !c.dispatch) return null;
    if (c.dispatch && c.state === "collecting" && ["expired_before_provider_dispatch", "missing_host_collection_authority"].includes(reason)) {
      // Trusted worker attests that the permit expired before any fetch; retain that receipt.
      tx.insert(learningKey("observation_no_dispatch_receipts", `${c.id}:${token}`), { workspaceId: c.workspaceId, brandId: c.brandId, dispatch: c.dispatch, reason, actor: tenantSubjectId(currentTenant()), at: now });
      const { dispatch: _dispatch, ...undispatched } = c; void _dispatch;
      return cancelUndispatched(tx, undispatched, reason, now);
    }
    return cancelUndispatched(tx, c, reason, now);
  });
}
export function collectionAuthorityDigest(c: Collection) {
  return strategyDigest({ id: c.id, workspaceId: c.workspaceId, brandId: c.brandId, itemRef: c.itemRef, planRef: c.planRef, campaignRef: c.campaignRef, strategyRef: c.strategyRef, sourceIds: c.sourceIds, jobId: c.jobId, actionId: c.actionId, postId: c.postId, artifactId: c.artifactId, measurement: c.measurement, window: c.window, dueAt: c.dueAt, expiresAt: c.expiresAt, costAuthorization: c.costAuthorization });
}
function insertCollectionReceipt(tx: DynamoTransaction, c: Collection, input: z.infer<typeof providerObservationInputSchema>, observation: PerformanceObservation, now: string) {
  tx.insert(learningKey("observation_collection_receipts", `${c.id}:${input.token}`), { workspaceId: c.workspaceId, brandId: c.brandId, collectionId: c.id, token: input.token, outcome: input.outcome, inputDigest: strategyDigest(input), observationId: observation.id, observationDigest: observation.digest, dispatchDigest: strategyDigest(c.dispatch), collectionAuthorityDigest: collectionAuthorityDigest(c), actor: tenantSubjectId(currentTenant()), recordedAt: now });
}
/** Persist an already received provider result; this function never dispatches a read. */
export async function persistProviderResult(tx: DynamoTransaction, c: Collection, input: z.infer<typeof providerObservationInputSchema>, now: string, additionalEvidence: string[] = []) {
  const job = await validBinding(c, tx);
  if (input.collectionId !== c.id || input.token !== c.dispatch?.token || c.measurement.definition.collectionMethod !== "official_x") throw new Error("provider result dispatch binding mismatch");
  if (input.outcome === "available" && (Date.parse(input.checkedAt) < Date.parse(c.dueAt) || Date.parse(input.checkedAt) < Date.parse(c.dispatch.issuedAt) || Date.parse(input.checkedAt) > Date.parse(c.expiresAt) || Date.parse(input.checkedAt) > Date.parse(now) + 5000)) throw new Error("provider observation outside pinned window");
  let result: ObservationValue = { availability: input.outcome === "failed" || input.outcome === "unknown" ? "failed" : "unavailable", value: null, reason: input.reason || input.outcome };
  if (input.outcome === "available") {
    if (!input.metrics) throw new Error("available provider observation requires metrics");
    const insight = priorInsightsFromJob(c.jobId, { ...job, engagement: [{ ...input.metrics, postId: c.postId!, actionId: c.actionId!, checkedAt: input.checkedAt }] })[0];
    if (insight.availability !== "available") throw new Error(`unverified X metric: ${insight.unavailableReason}`);
    const metric = c.measurement.definition.metricId.slice(2) as keyof typeof input.metrics, value = input.metrics[metric];
    result = value === undefined ? { availability: "unavailable", value: null, reason: "metric_not_returned" } : { availability: "available", value, reason: null };
  }
  const evidenceId = `provider-${strategyDigest({ input, additionalEvidence }).slice(0, 48)}`;
  const observed = buildObservation(c, result, input.checkedAt, { provider: "x", actor: additionalEvidence.length ? tenantSubjectId(currentTenant()) : undefined, evidenceRefs: [evidenceId, `verification:${c.jobId}:${c.actionId}`, ...additionalEvidence] });
  tx.insert(learningKey("observation_provider_evidence", evidenceId), { workspaceId: c.workspaceId, brandId: c.brandId, input, digest: strategyDigest(input), actor: tenantSubjectId(currentTenant()), receivedAt: now, postId: c.postId, actionId: c.actionId, jobId: c.jobId });
  await insertObservation(tx, observed); return observed;
}
export async function completeProviderObservation(raw: z.infer<typeof providerObservationInputSchema>, now = new Date().toISOString()) {
  const input = providerObservationInputSchema.parse(raw);
  const observation = await awsRepository().atomic(async tx => {
    const key = learningKey("observation_outbox", input.collectionId), c = await readRequired<Collection>(key, tx);
    const receiptKey = learningKey("observation_collection_receipts", `${c.id}:${input.token}`), old = await tx.read(receiptKey);
    if (old.present) { if (old.value?.inputDigest !== strategyDigest(input)) throw new Error("provider observation identity reused"); return readObservation(String(old.value!.observationId), tx); }
    if (!["collecting", "reconciliation_required"].includes(c.state) || c.token !== input.token || c.dispatch?.token !== input.token) throw new Error("stale observation dispatch authority");
    const observed = await persistProviderResult(tx, c, input, now);
    if (input.outcome !== "unknown") await settleCollectionCost(tx, c, "settled", now);
    tx.put(key, { ...c, state: input.outcome === "unknown" ? "reconciliation_required" : "completed", observationId: observed.id });
    insertCollectionReceipt(tx, c, input, observed, now); return observed;
  });
  await persistEvaluationForObservation(observation); return observation;
}
export async function recordOperatorObservation(input: { collectionId: string; requestId: string; value: number; evidenceText: string }, now = new Date().toISOString()) {
  requireContentOperator(currentTenant());
  if (!input.evidenceText.trim() || input.evidenceText.length > 10000 || !Number.isFinite(input.value) || !input.requestId) throw new Error("attributed operator evidence required");
  const observed = await awsRepository().atomic(async tx => {
    const key = learningKey("observation_outbox", input.collectionId), c = await readRequired<Collection>(key, tx);
    const receiptKey = learningKey("operator_observation_receipts", strategyDigest([tenantSubjectId(currentTenant()), input.requestId])); const old = await tx.read(receiptKey);
    if (old.present) { if (old.value?.inputDigest !== strategyDigest(input)) throw new Error("operator observation identity reused"); return readObservation(String(old.value!.observationId), tx); }
    await validBinding(c, tx);
    if (c.measurement.definition.collectionMethod !== "operator" || c.state !== "scheduled") throw new Error("operator observation requires an open operator measurement");
    if (Date.parse(now) < Date.parse(c.dueAt) || Date.parse(now) > Date.parse(c.expiresAt)) throw new Error("operator observation outside pinned window");
    if ((c.measurement.definition.unit === "count" && (!Number.isInteger(input.value) || input.value < 0)) || (c.measurement.definition.unit === "ratio" && (input.value < 0 || input.value > 1))) throw new Error("operator metric unit mismatch");
    const evidenceId = `operator-${strategyDigest([tenantSubjectId(currentTenant()), input.requestId]).slice(0, 48)}`;
    const observation = buildObservation(c, { availability: "available", value: input.value, reason: null }, now, { provider: "operator", actor: tenantSubjectId(currentTenant()), evidenceRefs: [evidenceId] });
    tx.insert(learningKey("observation_provider_evidence", evidenceId), { workspaceId: c.workspaceId, brandId: c.brandId, actor: tenantSubjectId(currentTenant()), observedAt: now, text: input.evidenceText, digest: strategyDigest(input), input });
    await insertObservation(tx, observation); tx.put(key, { ...c, state: "completed", observationId: observation.id });
    tx.insert(receiptKey, { workspaceId: c.workspaceId, brandId: c.brandId, inputDigest: strategyDigest(input), observationId: observation.id }); return observation;
  });
  await persistEvaluationForObservation(observed); return observed;
}
export async function listLearningObservations(): Promise<PerformanceObservation[]> {
  const rows = await awsRepository().query(partition(`${campaignRoot()}/observation_outbox`)); const observations: PerformanceObservation[] = [];
  for (const row of rows.rows) {
    const c = row.value as unknown as Collection, o = await readObservation(c.observationId);
    if (o.availability === "revoked") { observations.push(o); continue; }
    try { await validBinding(c, awsRepository()); observations.push(o); }
    catch (error) { if (!(error instanceof InvalidLearningEvidence)) throw error; observations.push(await invalidateCollection(c.id, error.message)); }
  }
  return observations;
}
async function invalidateCollection(id: string, reason: string) {
  return awsRepository().atomic(async tx => {
    const key = learningKey("observation_outbox", id), c = await readRequired<Collection>(key, tx), old = await readObservation(c.observationId, tx);
    if (old.availability === "revoked") return old;
    if (!c.dispatch) await settleCollectionCost(tx, c, "released", new Date().toISOString());
    const observation = buildObservation(c, { availability: "revoked", value: null, reason }, new Date().toISOString(), { provider: "host", evidenceRefs: [old.id] });
    await insertObservation(tx, observation); tx.put(key, { ...c, state: "completed", observationId: observation.id }); return observation;
  });
}
export async function revokeLearningObservations(selector: { jobId?: string; sourceId?: string }, reason: string) {
  if ((!selector.jobId && !selector.sourceId) || !reason.trim()) throw new Error("exact erasure scope and reason required");
  const rows = await awsRepository().query(partition(`${campaignRoot()}/observation_outbox`));
  for (const row of rows.rows) { const c = row.value as unknown as Collection; if (c.jobId === selector.jobId || (selector.sourceId && c.sourceIds.includes(selector.sourceId))) await invalidateCollection(c.id, reason); }
  const { flagRevokedLearningProposals } = await import("./proposals"); await flagRevokedLearningProposals();
}
export async function persistEvaluationForObservation(observation: PerformanceObservation) {
  if (observation.kind !== "performance" || observation.availability !== "available") return;
  const all = (await listLearningObservations()).filter(o => o.kind === "performance" && o.availability !== "revoked" && o.measurement.digest === observation.measurement.digest && strategyDigest(o.strategyRef) === strategyDigest(observation.strategyRef));
  if (!all.length) return;
  const evaluation = evaluateObservations(all);
  const { recordEvaluation, proposeFromEvaluation } = await import("./proposals");
  const evidence = await recordEvaluation(evaluation); await proposeFromEvaluation(evidence);
}
export async function recoverLearning() {
  const { plannedCalendar } = await import("../planning/commands");
  const failures: string[] = [];
  for (const item of await plannedCalendar()) if (item.lifecycle.status === "completed" && item.lifecycle.jobId) {
    try { await scheduleCompletedJob(item.lifecycle.jobId); } catch (error) { failures.push(`${item.ref.id}: ${error instanceof Error ? error.message : "learning recovery failed"}`); }
  }
  const rows = await awsRepository().query(partition(`${campaignRoot()}/observation_outbox`));
  for (const row of rows.rows) {
    try {
      const c = row.value as unknown as Collection;
      let observation = await readObservation(c.observationId);
      try { await validBinding(c, awsRepository()); } catch (error) { if (!(error instanceof InvalidLearningEvidence)) throw error; observation = await invalidateCollection(c.id, error.message); }
      await persistEvaluationForObservation(observation);
    } catch (error) { failures.push(`${row.id}: ${error instanceof Error ? error.message : "evaluation recovery failed"}`); }
  }
  if (failures.length) await awsRepository().put(learningKey("learning_recovery", "status"), { workspaceId: currentTenant().workspaceId, brandId: currentTenant().brandId, failures, checkedAt: new Date().toISOString() });
  return { failures };
}
export async function listLearningContext() {
  const observations = await listLearningObservations(); const { listStrategyChangeProposals, listEvaluationEvidence } = await import("./proposals");
  return { observations: observations.slice(-100), evaluations: (await listEvaluationEvidence()).map(e => e.evaluation!).slice(-50), proposals: (await listStrategyChangeProposals()).slice(-50), authority: "host_persisted" as const, memoryAuthority: "derived_recall_only" as const };
}
export async function learningInsights() {
  const history = await listLearningContext();
  const { validateLearningReference } = await import("./proposals");
  const proposals = history.proposals.filter(p => !["rejected", "superseded"].includes(p.status)).map(p => p.evidenceStatus === "revoked" ? { id: p.id, revision: p.revision, status: p.status, evidenceStatus: "revoked" as const } : p);
  const observations = history.observations.filter(o => o.availability !== "revoked");
  const performanceEvidenceRefs: Array<{ id: string; digest: string }> = [], advisoryEvidenceRefs: Array<{ id: string; digest: string }> = [];
  for (const record of [...observations.filter(o => o.availability === "available" && o.kind === "performance"), ...history.evaluations.filter(e => e.outcome === "observational" && e.sampleCount > 0), ...history.proposals.filter(p => p.evidenceStatus === "valid" && ["pending", "approved"].includes(p.status))]) {
    const resolved = await validateLearningReference(record.id);
    (resolved.capability === "performance" ? performanceEvidenceRefs : advisoryEvidenceRefs).push({ id: resolved.id, digest: resolved.digest });
  }
  const learningContext = { ...history, observations, proposals, performanceEvidenceRefs, advisoryEvidenceRefs };
  const topPosts: Array<import("../repository").PriorInsight & { observationRef: { id: string; digest: string }; measurementWindow: PerformanceObservation["window"] }> = [];
  for (const observation of learningContext.observations.filter(o => o.provider === "x" && o.availability === "available").slice(-5)) {
    const evidence = await readRequired<{ workspaceId: string; brandId: string; input: z.infer<typeof providerObservationInputSchema> }>(learningKey("observation_provider_evidence", observation.evidenceRefs[0]));
    const job = await readRequired<LearningJob>(jobKey(observation.jobId));
    if (evidence.input.metrics) topPosts.push(...priorInsightsFromJob(observation.jobId, { ...job, engagement: [{ ...evidence.input.metrics, actionId: observation.actionId!, postId: observation.postId!, checkedAt: observation.observedAt }] }).map(insight => ({ ...insight, observationRef: { id: observation.id, digest: observation.digest }, measurementWindow: observation.window })));
  }
  return { topPosts, learningContext };
}
