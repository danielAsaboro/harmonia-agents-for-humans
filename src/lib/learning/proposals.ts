import { contentStrategySchema } from "../contracts";
import { awsRepository, partition, type DynamoTransaction } from "../dynamo";
import { requireContentOperator } from "../authority";
import { currentTenant, tenantSubjectId } from "../tenancy";
import { campaignRoot, readRequired } from "../campaigns/repository";
import { readActiveStrategyRef, readStrategyRevision, insertStrategyProposal, decideStrategyProposal, type StrategyReader } from "../strategy/repository";
import { strategyDigest } from "../strategyApproval";
import { learningKey, assertLearningSources, readObservation, assertObservationUsable, InvalidLearningEvidence } from "./repository";
import { changeProposalInputSchema, strategyChangeProposalSchema, type ChangeProposalInput, type Evaluation, type LearningEvidence, type StrategyChangeProposal } from "./contracts";

async function readChangeProposal(id: string, reader: StrategyReader = awsRepository()) {
  const proposal = await readRequired<StrategyChangeProposal>(learningKey("strategy_change_proposals", id), reader);
  strategyChangeProposalSchema.parse(proposal);
  const mutable = new Set(["digest", "revision", "status", "evidenceStatus", "decisionActor", "decidedAt", "feedback", "approvedStrategyRef"]);
  const body = Object.fromEntries(Object.entries(proposal).filter(([key]) => !mutable.has(key)));
  if (strategyDigest(body) !== proposal.digest) throw new InvalidLearningEvidence("strategy change proposal digest mismatch");
  return proposal;
}

async function insertEvidence(tx: DynamoTransaction, body: Omit<LearningEvidence, "digest">): Promise<LearningEvidence> {
  const evidence = { ...body, digest: strategyDigest(body) }; const key = learningKey("learning_evidence", evidence.id), existing = await tx.read(key);
  if (existing.present) return readLearningEvidence(evidence.id, tx);
  tx.insert(key, evidence); return evidence;
}
export async function readLearningEvidence(id: string, reader: StrategyReader = awsRepository()): Promise<LearningEvidence> {
  const evidence = await readRequired<LearningEvidence>(learningKey("learning_evidence", id), reader);
  const { digest, ...body } = evidence; if (strategyDigest(body) !== digest) throw new Error("learning evidence digest mismatch"); return evidence;
}
export async function validateLearningEvidence(id: string, digest: string, reader: StrategyReader = awsRepository()) {
  const evidence = await readLearningEvidence(id, reader); if (evidence.digest !== digest) throw new InvalidLearningEvidence("stale learning evidence reference");
  await assertLearningSources(evidence.sourceIds, reader);
  const revoked = await reader.read(learningKey("learning_revocations", evidence.id)); if (revoked.present) throw new InvalidLearningEvidence("learning evidence revoked");
  for (const observationId of evidence.observationIds) await assertObservationUsable(await readObservation(observationId, reader), reader, evidence.kind !== "evaluation");
  if (evidence.kind === "source_discovery") {
    const source = await readRequired(learningKey("sources", evidence.sourceIds[0]), reader);
    if (strategyDigest(source) !== evidence.sourceDigest) throw new InvalidLearningEvidence("source discovery evidence changed or revoked");
  }
  return evidence;
}
/** Resolve exact host records, including their original window and observation lineage. */
export async function validateLearningReference(id: string, expectedDigest?: string, reader: StrategyReader = awsRepository()): Promise<{ id: string; digest: string }> {
  let digest: string;
  if (id.startsWith("observation-")) {
    const observation = await readObservation(id, reader); await assertObservationUsable(observation, reader);
    if (observation.kind !== "performance") throw new InvalidLearningEvidence("delivery receipt is not performance evidence");
    digest = observation.digest;
  } else if (id.startsWith("change-")) {
    const proposal = await readChangeProposal(id, reader);
    if (proposal.evidenceStatus === "revoked") throw new InvalidLearningEvidence("proposal evidence revoked");
    await readStrategyRevision(proposal.baseStrategyRef, reader);
    for (const ref of [...proposal.evidenceRefs, ...proposal.contradictionRefs]) await validateLearningEvidence(ref.id, ref.digest, reader);
    digest = proposal.digest;
  } else {
    const evidence = await readLearningEvidence(id, reader);
    if (evidence.evaluation && (evidence.evaluation.outcome !== "observational" || !evidence.evaluation.sampleCount)) throw new InvalidLearningEvidence("unmeasured evaluation is not performance evidence");
    await validateLearningEvidence(id, evidence.digest, reader); digest = evidence.digest;
  }
  if (expectedDigest !== undefined && expectedDigest !== digest) throw new InvalidLearningEvidence("learning evidence digest mismatch");
  return { id, digest };
}
export async function recordOperatorFeedback(input: { requestId: string; text: string; sourceIds: string[] }) {
  requireContentOperator(currentTenant()); if (!input.text.trim() || input.text.length > 10000 || input.sourceIds.length > 24) throw new Error("bounded operator feedback required");
  const id = `feedback-${strategyDigest([tenantSubjectId(currentTenant()), input.requestId]).slice(0, 48)}`;
  return awsRepository().atomic(async tx => {
    await assertLearningSources(input.sourceIds, tx);
    const prior = await tx.read(learningKey("learning_evidence", id));
    if (prior.present) { const evidence = await readLearningEvidence(id, tx); if (evidence.text !== input.text || strategyDigest(evidence.sourceIds) !== strategyDigest(input.sourceIds)) throw new Error("feedback identity reused"); return evidence; }
    const t = currentTenant(); return insertEvidence(tx, { id, workspaceId: t.workspaceId, brandId: t.brandId, kind: "operator_feedback", sourceIds: input.sourceIds, observationIds: [], actor: tenantSubjectId(t), text: input.text, createdAt: new Date().toISOString() });
  });
}
export async function recordSourceDiscovery(sourceId: string) {
  return awsRepository().atomic(async tx => {
    await assertLearningSources([sourceId], tx); const source = await readRequired(learningKey("sources", sourceId), tx);
    const sourceDigest = strategyDigest(source), t = currentTenant();
    return insertEvidence(tx, { id: `discovery-${strategyDigest([sourceId, sourceDigest]).slice(0, 48)}`, workspaceId: t.workspaceId, brandId: t.brandId, kind: "source_discovery", sourceIds: [sourceId], sourceDigest, observationIds: [], actor: tenantSubjectId(t), text: `Ready source ${sourceId} is available for strategy review; discovery alone does not establish a performance improvement.`, createdAt: new Date().toISOString() });
  });
}
export async function recordEvaluation(evaluation: Evaluation) {
  return awsRepository().atomic(async tx => {
    const observations = await Promise.all(evaluation.observationIds.map(id => readObservation(id, tx)));
    for (const observation of observations) await assertObservationUsable(observation, tx, false);
    const { evaluateObservations } = await import("./evaluation"); const actual = evaluateObservations(observations);
    if (strategyDigest(actual) !== strategyDigest(evaluation)) throw new Error("evaluation does not match immutable observations");
    const t = currentTenant();
    return insertEvidence(tx, { id: evaluation.id, workspaceId: t.workspaceId, brandId: t.brandId, kind: "evaluation", sourceIds: [...new Set(observations.flatMap(o => o.sourceIds))], observationIds: evaluation.observationIds, actor: tenantSubjectId(t), text: `${evaluation.sampleCount} compatible item observations for ${evaluation.measurement.definition.metricId}; descriptive evidence only.`, evaluation, createdAt: new Date().toISOString() });
  });
}
function materializeChanges(strategy: Parameters<typeof contentStrategySchema.parse>[0], changes: ChangeProposalInput["changes"], evidenceIds: string[]) {
  const proposed = contentStrategySchema.parse(strategy);
  // Version is the bounded Task 1 proposal attempt, not the lifetime revision.
  proposed.version = 1;
  for (const change of changes) {
    if (change.type === "cadence_guidance") proposed.cadenceGuidance = change.value;
    else if (change.type === "cta_guidance") proposed.ctaGuidance = change.value;
    else if (change.type === "pillar_purpose") {
      const matches = proposed.pillars.filter(p => p.name === change.pillar); if (matches.length !== 1) throw new Error("exact pillar required for typed change"); matches[0].purpose = change.value;
    } else if (!proposed.assumptions.some(a => a.text === change.value)) proposed.assumptions.push({ text: change.value, evidenceRefs: evidenceIds, confidence: "low" });
  }
  return contentStrategySchema.parse(proposed);
}
export async function createStrategyChangeProposal(raw: ChangeProposalInput): Promise<StrategyChangeProposal> {
  const input = changeProposalInputSchema.parse(raw), t = currentTenant();
  const id = `change-${strategyDigest([t.workspaceId, t.brandId, input.requestId]).slice(0, 48)}`;
  return awsRepository().atomic(async tx => {
    const key = learningKey("strategy_change_proposals", id), prior = await tx.read(key);
    if (prior.present) { const proposal = await readChangeProposal(id, tx); const original = changeProposalInputSchema.parse(Object.fromEntries(Object.keys(input).map(key => [key, proposal[key as keyof StrategyChangeProposal]]))); if (strategyDigest(original) !== strategyDigest(input)) throw new Error("change proposal identity reused"); return proposal; }
    const active = await readActiveStrategyRef(tx); if (strategyDigest(active) !== strategyDigest(input.baseStrategyRef)) throw new Error("stale strategy change base");
    const base = await readStrategyRevision(input.baseStrategyRef, tx);
    const evidence = await Promise.all([...input.evidenceRefs, ...input.contradictionRefs].map(ref => validateLearningEvidence(ref.id, ref.digest, tx)));
    const evaluations = evidence.flatMap(e => e.evaluation ? [e.evaluation] : []);
    if (evaluations.some(e => strategyDigest(e.strategyRef) !== strategyDigest(input.baseStrategyRef) || e.outcome !== "observational" || !e.sampleCount)) throw new Error("performance proposal requires compatible measured evidence, not delivery verification");
    const strategy = materializeChanges(base.strategy, input.changes, input.evidenceRefs.map(ref => ref.id)), proposedStrategyDigest = strategyDigest(strategy), now = new Date().toISOString();
    const learningEvidence = [...new Map([...(base.invocationContext.learningEvidence ?? []), ...evidence.map(e => ({ id: e.id, digest: e.digest }))].map(ref => [ref.id, ref])).values()];
    const exact = await insertStrategyProposal(tx, { jobId: id, attempt: 1, strategy, digest: proposedStrategyDigest, evidenceLineage: [...base.evidenceLineage, ...evidence.map(e => e.id)], invocationContext: { ...base.invocationContext, learningEvidence, revision: 1, researchRequest: null, memoryFacts: [] }, proposedAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }, input.baseStrategyRef);
    const { plannedCalendar } = await import("../planning/commands"); const impacted = (await plannedCalendar(tx)).filter(item => strategyDigest(item.strategyRef) === strategyDigest(input.baseStrategyRef));
    const unique = <T>(values: T[]) => [...new Map(values.map(value => [strategyDigest(value), value])).values()];
    const body = { ...input, id, workspaceId: t.workspaceId, brandId: t.brandId, actor: tenantSubjectId(t), createdAt: now, confidence: evaluations.length ? evaluations.some(e => e.confidence === "low") ? "low" as const : "moderate" as const : "insufficient" as const, limitations: [...new Set([...evaluations.flatMap(e => e.limitations), ...(!evaluations.length ? ["Source discovery and operator feedback are not measured performance evidence."] : [])])], strategyProposalId: exact.id, proposedStrategyDigest,
      impactedCampaignRefs: unique(impacted.flatMap(item => item.campaignRef ? [item.campaignRef] : [])), impactedPlanRefs: unique(impacted.map(item => item.planRef)), impactedItemRefs: impacted.map(item => item.ref) };
    const proposal: StrategyChangeProposal = { ...body, revision: 1, status: "pending", evidenceStatus: "valid", digest: strategyDigest(body) };
    tx.insert(key, proposal); return proposal;
  });
}
export async function proposeFromEvaluation(evidence: LearningEvidence) {
  if (!evidence.evaluation || evidence.evaluation.outcome !== "observational" || !evidence.evaluation.sampleCount) return null;
  const active = await readActiveStrategyRef(); if (strategyDigest(active) !== strategyDigest(evidence.evaluation.strategyRef)) return null;
  return createStrategyChangeProposal({ requestId: evidence.id, baseStrategyRef: evidence.evaluation.strategyRef, changes: [{ type: "assumption", value: `Review ${evidence.id}: ${evidence.evaluation.sampleCount} compatible observations of ${evidence.evaluation.measurement.definition.metricId}; no causal or winning-pattern claim.` }], rationale: "Measured evidence is available for operator review. Retain this bounded observation as an explicit strategy assumption pending further measurement.", evidenceRefs: [{ id: evidence.id, digest: evidence.digest }], contradictionRefs: evidence.evaluation.contradictingObservationIds.length ? [{ id: evidence.id, digest: evidence.digest }] : [] });
}
export async function decideStrategyChange(input: { id: string; revision: number; digest: string; decision: "approved" | "rejected"; feedback?: string }) {
  requireContentOperator(currentTenant());
  return awsRepository().atomic(async tx => {
    const key = learningKey("strategy_change_proposals", input.id), proposal = await readChangeProposal(input.id, tx), actor = tenantSubjectId(currentTenant());
    if (proposal.digest !== input.digest) throw new Error("strategy change payload changed");
    if (proposal.status !== "pending") {
      if (proposal.status === input.decision && proposal.decisionActor === actor && proposal.revision === input.revision + 1 && (proposal.feedback ?? "") === (input.feedback?.trim() ?? "")) return proposal;
      throw new Error("strategy change decision already recorded");
    }
    if (proposal.revision !== input.revision) throw new Error("stale strategy change revision");
    if (strategyDigest(await readActiveStrategyRef(tx)) !== strategyDigest(proposal.baseStrategyRef)) throw new Error("stale strategy change base");
    await readStrategyRevision(proposal.baseStrategyRef, tx);
    for (const ref of [...proposal.evidenceRefs, ...proposal.contradictionRefs]) await validateLearningEvidence(ref.id, ref.digest, tx);
    const result = await decideStrategyProposal(tx, proposal.strategyProposalId, { decision: input.decision, payloadDigest: proposal.proposedStrategyDigest, expectedActiveRevision: proposal.baseStrategyRef.revision, ...(input.feedback ? { feedback: input.feedback } : {}) });
    const next: StrategyChangeProposal = { ...proposal, status: input.decision, revision: proposal.revision + 1, decisionActor: actor, decidedAt: result.approval.decidedAt, ...(input.feedback ? { feedback: input.feedback.trim() } : {}), ...(result.strategyRef ? { approvedStrategyRef: result.strategyRef } : {}) };
    tx.put(key, next); return next;
  });
}
export async function listStrategyChangeProposals() {
  const rows = await awsRepository().query(partition(`${campaignRoot()}/strategy_change_proposals`)); const result: StrategyChangeProposal[] = [];
  for (const row of rows.rows) {
    let proposal = await readChangeProposal(row.id);
    let valid = true;
    try { await readStrategyRevision(proposal.baseStrategyRef); for (const ref of [...proposal.evidenceRefs, ...proposal.contradictionRefs]) await validateLearningEvidence(ref.id, ref.digest); }
    catch (error) { if (!isInvalidEvidence(error)) throw error; valid = false; }
    if (proposal.status === "pending") proposal = await awsRepository().atomic(async tx => {
      const current = await readChangeProposal(row.id, tx);
      if (current.status !== "pending" || strategyDigest(await readActiveStrategyRef(tx)) === strategyDigest(current.baseStrategyRef)) return current;
      const next = { ...current, status: "superseded" as const, revision: current.revision + 1 }; tx.put(row.key, next); return next;
    });
    result.push({ ...proposal, evidenceStatus: valid ? "valid" : "revoked" });
  }
  return result;
}
function isInvalidEvidence(error: unknown) { return error instanceof InvalidLearningEvidence || (error instanceof Error && (error.message.endsWith("authority not found") || error.message.endsWith("digest mismatch"))); }
export async function listEvaluationEvidence() {
  const rows = await awsRepository().query(partition(`${campaignRoot()}/learning_evidence`)); const result: LearningEvidence[] = [];
  for (const row of rows.rows) if (row.value?.kind === "evaluation") { try { result.push(await validateLearningEvidence(row.id, String(row.value.digest))); } catch (error) { if (!isInvalidEvidence(error)) throw error; /* historical receipt is retained */ } }
  return result;
}
export async function revokeLearningEvidence(id: string, reason: string) {
  requireContentOperator(currentTenant()); const evidence = await readLearningEvidence(id);
  await awsRepository().put(learningKey("learning_revocations", id), { workspaceId: evidence.workspaceId, brandId: evidence.brandId, actor: tenantSubjectId(currentTenant()), reason, revokedAt: new Date().toISOString() });
  await flagRevokedLearningProposals();
}
export async function flagRevokedLearningProposals() {
  for (const proposal of await listStrategyChangeProposals()) if (proposal.evidenceStatus === "revoked") await awsRepository().atomic(async tx => {
    const key = learningKey("strategy_change_proposals", proposal.id), current = await readRequired<StrategyChangeProposal>(key, tx);
    if (current.evidenceStatus !== "revoked") tx.put(key, { ...current, evidenceStatus: "revoked" });
  });
}
