import { randomBytes } from "node:crypto";
import { z } from "zod";
import { awsRepository, partition, recordKey, type DynamoTransaction } from "../dynamo";
import { assertResourceWorkspace, currentTenant, tenantSubjectId } from "../tenancy";
import { requireContentOperator } from "../authority";
import { applyReservation, canReserve, exceedsApprovalThreshold, usdToMicros } from "../costs";
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
async function validBinding(collection: Collection, reader: StrategyReader) {
  assertResourceWorkspace(currentTenant(), collection);
  const item = await readPlannedItem(collection.itemRef, reader); const state = await readItemState(item.ref, reader);
  if (state.jobId !== collection.jobId || state.status !== "completed" || !item.measurements.some(m => strategyDigest(m) === strategyDigest(collection.measurement))) throw new InvalidLearningEvidence("observation item/job/measurement binding changed");
  const tombstone = await reader.read(recordKey(`workspaces/${currentTenant().workspaceId}/deletion_tombstones/${collection.jobId}`));
  if (tombstone.present) throw new InvalidLearningEvidence("learning job evidence revoked");
  const job = await readRequired<LearningJob>(jobKey(collection.jobId), reader);
  if (strategyDigest(job.plannedItemRef) !== strategyDigest(item.ref) || strategyDigest(job.strategyRef) !== strategyDigest(collection.strategyRef)) throw new InvalidLearningEvidence("observation strategy binding changed");
  await assertLearningSources(collection.sourceIds, reader); return job;
}
export async function readObservation(id: string, reader: StrategyReader = awsRepository()): Promise<PerformanceObservation> {
  const observation = await readRequired<PerformanceObservation>(learningKey("performance_observations", id), reader);
  const { digest, ...body } = observation;
  if (strategyDigest(body) !== digest) throw new Error("observation authority digest mismatch");
  return observation;
}
export async function assertObservationUsable(observation: PerformanceObservation, reader: StrategyReader = awsRepository()) {
  if (observation.availability !== "available") throw new InvalidLearningEvidence("observation evidence unavailable or revoked");
  const collection = await readRequired<Collection>(learningKey("observation_outbox", observation.collectionId), reader);
  await validBinding(collection, reader);
  if (collection.observationId !== observation.id || collection.state !== "completed") throw new InvalidLearningEvidence("observation superseded, revoked or unresolved");
}
function buildObservation(collection: Collection, result: ObservationValue, now: string, attribution: { provider: PerformanceObservation["provider"]; actor?: string; evidenceRefs?: string[] }): PerformanceObservation {
  observationValueSchema.parse(result);
  const id = `observation-${strategyDigest({ collectionId: collection.id, result, now, attribution }).slice(0, 48)}`;
  const body = { id, collectionId: collection.id, workspaceId: collection.workspaceId, brandId: collection.brandId, itemRef: collection.itemRef, planRef: collection.planRef, campaignRef: collection.campaignRef, strategyRef: collection.strategyRef, pillar: collection.pillar, jobId: collection.jobId, actionId: collection.actionId, artifactId: collection.artifactId, postId: collection.postId, sourceIds: collection.sourceIds, measurement: collection.measurement, kind: collection.measurement.definition.kind, window: collection.window, observedAt: now, ...result, provider: attribution.provider, actor: attribution.actor ?? null, evidenceRefs: attribution.evidenceRefs ?? [] };
  return { ...body, digest: strategyDigest(body) };
}
async function insertObservation(tx: DynamoTransaction, observation: PerformanceObservation) {
  const key = learningKey("performance_observations", observation.id), old = await tx.read(key);
  if (old.present) { if (old.value?.digest !== observation.digest) throw new Error("observation identity reused"); return; }
  tx.insert(key, observation);
}
/** Recovery calls this for completed items. Definition, anchor and provider target are frozen once. */
export async function scheduleCompletedJob(jobId: string, now = new Date().toISOString()): Promise<Collection[]> {
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
      const observation = buildObservation(c, { availability: "failed", value: null, reason: "collector_response_unknown_requires_reconciliation" }, now, { provider: "host" });
      await insertObservation(tx, observation); tx.put(key, { ...c, state: "reconciliation_required", observationId: observation.id }); return null;
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
export async function claimDueObservations() { const result: Collection[] = []; for (const c of await dueObservationCollections()) { const claimed = await claimObservation(c.id, randomBytes(32).toString("hex")); if (claimed) result.push(claimed); } return result; }
export async function completeProviderObservation(raw: z.infer<typeof providerObservationInputSchema>, now = new Date().toISOString()) {
  const input = providerObservationInputSchema.parse(raw);
  const observation = await awsRepository().atomic(async tx => {
    const key = learningKey("observation_outbox", input.collectionId), c = await readRequired<Collection>(key, tx);
    const receiptKey = learningKey("observation_collection_receipts", `${c.id}:${input.token}`), old = await tx.read(receiptKey);
    if (old.present) { if (old.value?.inputDigest !== strategyDigest(input)) throw new Error("provider observation identity reused"); return readObservation(String(old.value!.observationId), tx); }
    if (c.state !== "collecting" || c.token !== input.token || Date.parse(c.leaseUntil!) < Date.parse(now)) throw new Error("stale observation claim");
    const job = await validBinding(c, tx);
    if (input.outcome === "available" && (Date.parse(input.checkedAt) < Date.parse(c.dueAt) || Date.parse(input.checkedAt) > Date.parse(c.expiresAt) || Date.parse(input.checkedAt) > Date.parse(now) + 5000)) throw new Error("provider observation outside pinned window");
    let result: ObservationValue = { availability: input.outcome === "failed" || input.outcome === "unknown" ? "failed" : "unavailable", value: null, reason: input.reason || input.outcome };
    if (input.outcome === "available" && input.metrics) {
      const insight = priorInsightsFromJob(c.jobId, { ...job, engagement: [{ ...input.metrics, postId: c.postId!, actionId: c.actionId!, checkedAt: input.checkedAt }] })[0];
      if (insight.availability !== "available") throw new Error(`unverified X metric: ${insight.unavailableReason}`);
      const metric = c.measurement.definition.metricId.slice(2) as keyof typeof input.metrics;
      const value = input.metrics[metric];
      result = value === undefined ? { availability: "unavailable", value: null, reason: "metric_not_returned" } : { availability: "available", value, reason: null };
    }
    const evidenceId = `provider-${strategyDigest(input).slice(0, 48)}`;
    const observed = buildObservation(c, result, input.checkedAt, { provider: "x", evidenceRefs: [evidenceId, `verification:${c.jobId}:${c.actionId}`] });
    tx.insert(learningKey("observation_provider_evidence", evidenceId), { workspaceId: c.workspaceId, brandId: c.brandId, input, digest: strategyDigest(input), actor: tenantSubjectId(currentTenant()), receivedAt: now, postId: c.postId, actionId: c.actionId, jobId: c.jobId });
    await insertObservation(tx, observed);
    tx.put(key, { ...c, state: input.outcome === "unknown" ? "reconciliation_required" : "completed", observationId: observed.id });
    tx.insert(receiptKey, { workspaceId: c.workspaceId, brandId: c.brandId, inputDigest: strategyDigest(input), observationId: observed.id }); return observed;
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
  const all = (await listLearningObservations()).filter(o => o.kind === "performance" && o.availability === "available" && o.measurement.digest === observation.measurement.digest && strategyDigest(o.strategyRef) === strategyDigest(observation.strategyRef));
  if (!all.length) return;
  const evaluation = evaluateObservations(all);
  const { recordEvaluation, proposeFromEvaluation } = await import("./proposals");
  const evidence = await recordEvaluation(evaluation); await proposeFromEvaluation(evidence);
}
export async function recoverLearning() {
  const { plannedCalendar } = await import("../planning/commands");
  for (const item of await plannedCalendar()) if (item.lifecycle.status === "completed" && item.lifecycle.jobId) await scheduleCompletedJob(item.lifecycle.jobId);
  for (const observation of await listLearningObservations()) await persistEvaluationForObservation(observation);
}
export async function listLearningContext() {
  const observations = await listLearningObservations(); const { listStrategyChangeProposals, listEvaluationEvidence } = await import("./proposals");
  return { observations: observations.slice(-100), evaluations: (await listEvaluationEvidence()).map(e => e.evaluation!).slice(-50), proposals: (await listStrategyChangeProposals()).slice(-50), authority: "host_persisted" as const, memoryAuthority: "derived_recall_only" as const };
}
export async function learningInsights() {
  const learningContext = await listLearningContext();
  const topPosts: import("../repository").PriorInsight[] = [];
  for (const observation of learningContext.observations.filter(o => o.provider === "x" && o.availability === "available").slice(-5)) {
    const evidence = await readRequired<{ workspaceId: string; brandId: string; input: z.infer<typeof providerObservationInputSchema> }>(learningKey("observation_provider_evidence", observation.evidenceRefs[0]));
    const job = await readRequired<LearningJob>(jobKey(observation.jobId));
    if (evidence.input.metrics) topPosts.push(...priorInsightsFromJob(observation.jobId, { ...job, engagement: [{ ...evidence.input.metrics, actionId: observation.actionId!, postId: observation.postId!, checkedAt: observation.observedAt }] }));
  }
  return { topPosts, learningContext };
}
