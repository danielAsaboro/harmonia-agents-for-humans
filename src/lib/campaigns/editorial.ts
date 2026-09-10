import type { EditorialPlan, Job } from "../types";
import type { DynamoTransaction } from "../dynamo";
import { strategyDigest } from "../strategyApproval";
import { editorialPlanDigest, editorialPlanningSnapshotDigest } from "../editorialPlan";
import { buildStrategySourceBinding } from "../strategy/sourceBinding";
import { currentTenant, tenantSubjectId } from "../tenancy";
import { authorityKey, pointerKey, readPlan, readPlannedItem, readItemState, readPlanningPolicy, readRequired, scopedRef, writeCampaign, withItemProductionContext } from "./repository";
import type { PlanningPolicy } from "./contracts";
import type { PlanRevision, PlannedItem, PlannedItemState } from "./contracts";
import type { StrategyReader } from "../strategy/repository";
import { sourceAnalysisDigest } from "../sourceAnalysis";
import { calendarConflicts, plannedCalendar } from "../planning/commands";

export async function persistEditorialPlan(tx: DynamoTransaction, job: Job, plan: EditorialPlan): Promise<PlanRevision> {
  const policy = await readPlanningPolicy(tx);
  if (plan.timezone !== policy.timezone) throw new Error("editorial plan timezone differs from configured policy");
  const now = new Date().toISOString();
  const ref = scopedRef(`plan-${strategyDigest(job.id).slice(0, 48)}`, plan.version);
  const existing = await tx.read(authorityKey("plan_revisions", ref));
  if (existing.present) {
    const prior = await readPlan(ref, tx);
    if (prior.acceptedEditorialDigest !== editorialPlanDigest(plan)) throw new Error("editorial plan revision already accepted"); return prior;
  }
  if (!job.strategyRef || !job.sourceAnalysis || !job.editorialPlanningSnapshot) throw new Error("editorial source and strategy authority required");
  if (!job.editorialPlanningSnapshot.provenanceIds.includes(`policy:${policy.ref.id}:v${policy.ref.revision}`)) throw new Error("planning policy changed; a new snapshot is required");
  const campaign = job.config.intake?.disposition === "new_initiative" ? await writeCampaign(tx, { id: `campaign-${strategyDigest(job.id).slice(0, 48)}`, name: job.config.intake.expectedOutcome, objective: job.config.intake.expectedOutcome, strategyRef: job.strategyRef }, 0) : null;
  const refs = new Map(plan.items.map(item => [item.id, scopedRef(`item-${strategyDigest([ref.id, item.id]).slice(0, 48)}`, 1)]));
  const committed = await plannedCalendar(tx);
  const proposed = plan.items.map(item => ({ ref: refs.get(item.id)!, channel: item.channel, scheduledFor: item.publicationWindowStartAt }));
  for (const item of proposed) { const conflicts = calendarConflicts(item, [...committed, ...proposed], policy); if (conflicts.length) throw new Error(`editorial plan capacity proposal required: ${conflicts.join("; ")}`); }
  const record: PlanRevision = { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, campaignRef: campaign?.ref ?? null, strategyRef: job.strategyRef, policyRef: policy.ref, itemRefs: [...refs.values()], createdAt: now, createdBy: tenantSubjectId(currentTenant()), reason: plan.summary, acceptedEditorialDigest: editorialPlanDigest(plan) };
  const { items: _items, selectedNextItemId: _selected, ...planContext } = plan;
  void _items; void _selected;
  for (const proposal of plan.items) {
    const itemRef = refs.get(proposal.id)!;
    const item: PlannedItem = withItemProductionContext({ ref: itemRef, workspaceId: ref.workspaceId, brandId: ref.brandId, planRef: ref, campaignRef: record.campaignRef, strategyRef: job.strategyRef, name: proposal.campaignTheme, objective: proposal.objective, operatorBrief: job.config.operatorBrief ?? proposal.objective, requestedOutputs: job.config.desiredOutputs, channel: proposal.channel, scheduledFor: proposal.publicationWindowStartAt,
      publicationWindowEndAt: proposal.publicationWindowEndAt, productionDeadlineAt: proposal.productionDeadlineAt, productionReadyAt: plan.horizonStartAt, dependencies: proposal.dependencies.map(id => { const dependency = refs.get(id); if (!dependency) throw new Error(`unknown planned dependency ${id}`); return dependency; }), requiredAssetIds: proposal.requiredAssets,
      evidence: { mode: "source_backed", sourceJobId: job.id, sourceBinding: buildStrategySourceBinding({ ...job, sourceAnalysis: job.sourceAnalysis }) }, productionContext: { mode: "source_backed", policyRef: policy.ref, plan: planContext, item: proposal, snapshot: job.editorialPlanningSnapshot, config: job.config, sourceAnalysis: job.sourceAnalysis }, editorialItemId: proposal.id, createdAt: now });
    tx.insert(authorityKey("planned_item_revisions", itemRef), item);
    tx.insert(authorityKey("planned_item_states", itemRef), { ref: itemRef, workspaceId: ref.workspaceId, brandId: ref.brandId, status: "planned", updatedAt: now } satisfies PlannedItemState);
  }
  tx.insert(authorityKey("plan_revisions", ref), record); tx.put(pointerKey("plans", ref.id), ref); return record;
}

/** Runtime projections are rebuilt from immutable plan/item authority, never stored on the job. */
export async function resolvePlannedJob<T extends Job>(job: T, reader?: StrategyReader): Promise<T> {
  if (!job.planRef) return job;
  const plan = await readPlan(job.planRef, reader);
  if (strategyDigest(plan.strategyRef) !== strategyDigest(job.strategyRef)) throw new Error("planned job strategy reference mismatch");
  const selected = job.plannedItemRef ? await readPlannedItem(job.plannedItemRef, reader) : null;
  if (selected && (strategyDigest(selected.planRef) !== strategyDigest(plan.ref) || !plan.itemRefs.some(ref => strategyDigest(ref) === strategyDigest(selected.ref)))) throw new Error("planned job item binding mismatch");
  if (selected) {
    if (job.config.operatorBrief !== selected.operatorBrief || strategyDigest(job.config.desiredOutputs) !== strategyDigest(selected.requestedOutputs) || strategyDigest(job.config.allowedOutputs) !== strategyDigest(selected.requestedOutputs)) throw new Error("planned item context or output selection changed");
    if (selected.evidence.mode === "operator_context" && strategyDigest(job.operatorPlanningContext) !== strategyDigest(selected.evidence)) throw new Error("planned item context binding mismatch");
    if (selected.evidence.mode === "source_backed" && (!job.sourceAnalysis || !("analysisDigest" in selected.evidence.sourceBinding) || sourceAnalysisDigest(job.sourceAnalysis) !== selected.evidence.sourceBinding.analysisDigest)) throw new Error("planned item source analysis binding mismatch");
  }
  if (!selected) return job;
  const context = selected.productionContext;
  if (context.mode === "operator_context") {
    if (!job.contentStrategy || job.operatorPlanningContext?.mode !== "operator_context") throw new Error("operator planning context required");
    const strategy = job.contentStrategy;
    const brief = strategy.briefs.find(brief => brief.channelCandidates.includes(selected.channel));
    if (!brief) throw new Error("no approved brief for selected channel");
    const policy = await readRequired<PlanningPolicy>(authorityKey("planning_policy_revisions", context.policyRef), reader);
    const state = await readItemState(selected.ref, reader);
    const start = new Date(selected.scheduledFor).toISOString();
    const end = new Date(Date.parse(start) + 3600000).toISOString();
    const horizonEnd = new Date(Date.parse(start) + strategy.horizonWeeks * 7 * 86400000).toISOString();
    const snapshot: import("../types").EditorialPlanningSnapshot = { sourceBinding: buildStrategySourceBinding(job), snapshotId: `planning-${job.id}-v1`, asOf: plan.createdAt, horizonStartAt: start, horizonEndAt: horizonEnd, timezone: policy.timezone, channelCapabilities: strategy.channelRoles.filter(role => role.operationallySupported).map(role => ({ channel: role.channel, formats: role.formats })), existingCommitments: [], productionCapacity: policy.productionCapacity, cadenceConstraints: policy.cadenceConstraints, postingWindowObservations: [], assetReadiness: [], blockedDependencies: [], calendarProjection: [], provenanceIds: [`policy:${policy.ref.id}:v${policy.ref.revision}`] };
    const snapshotDigest = editorialPlanningSnapshotDigest(snapshot);
    const item: import("../types").EditorialPlanItem = { id: selected.ref.id, briefId: brief.id, campaignTheme: selected.name, contentPillar: strategy.pillars[0].name, objective: selected.objective, audienceId: brief.audienceId, funnelStage: brief.funnelStage, intendedConversion: brief.intendedConversion, ctaIntent: brief.ctaIntent, kpi: brief.kpi, channel: selected.channel, format: brief.formatCandidates[0], evidenceRefs: [], publicationWindowStartAt: start, publicationWindowEndAt: end, productionDeadlineAt: start, priority: brief.priority, selectionScore: 1, dependencies: [], productionStatus: "planned", constraints: ["Operator brief is context, not factual evidence. Produce creative language only. Do not invent facts, quotes, statistics, testimonials, product capabilities or citations.", ...brief.constraints].slice(0, 12), requiredAssets: [], planningRationale: "Operator-selected output under the approved strategy and configured production policy.", selectionRationale: "Host-selected eligible planned item.", confidence: "high" };
    const editorial: EditorialPlan = { planId: plan.ref.id, version: 1, approvedStrategyDigest: job.strategyRef!.digest, planningSnapshotId: snapshot.snapshotId, planningSnapshotDigest: snapshotDigest, horizonStartAt: start, horizonEndAt: horizonEnd, timezone: policy.timezone, summary: selected.objective, sequencingRationale: "Operator-selected planned work", cadenceRationale: "Configured production policy", assumptions: [], confidence: "high", items: [item], selectedNextItemId: item.id };
    return { ...job, editorialPlan: editorial, editorialPlanDigest: editorialPlanDigest(editorial), editorialPlanRevision: plan.ref.revision, editorialPlanningSnapshot: snapshot, editorialPlanningSnapshotDigest: snapshotDigest, selectedNextItemId: item.id, editorialItemStates: { [item.id]: { status: state.status === "awaiting_approval" ? "awaiting_approval" : job.activeProductionLineage ? "drafting" : "selected", updatedAt: state.updatedAt } } };
  }
  const snapshot = { ...context.snapshot, sourceBinding: buildStrategySourceBinding(job) };
  const snapshotDigest = editorialPlanningSnapshotDigest(snapshot);
  if (!selected.publicationWindowEndAt || !selected.productionDeadlineAt) throw new Error("editorial item schedule authority missing");
  const editorial: EditorialPlan = { ...context.plan, planningSnapshotDigest: snapshotDigest, selectedNextItemId: context.item.id, items: [{ ...context.item, publicationWindowStartAt: selected.scheduledFor, publicationWindowEndAt: selected.publicationWindowEndAt, productionDeadlineAt: selected.productionDeadlineAt, dependencies: [] }] };
  const states: NonNullable<Job["editorialItemStates"]> = {};
  for (const ref of [selected.ref]) {
    const item = await readPlannedItem(ref, reader); const state = await readItemState(ref, reader);
    states[item.editorialItemId!] = { status: state.status === "running" ? job.activeProductionLineage ? "drafting" : "selected" : state.status === "awaiting_approval" ? "awaiting_approval" : state.status === "completed" ? "reviewed" : "planned", updatedAt: state.updatedAt };
  }
  return { ...job, editorialPlan: editorial, editorialPlanDigest: editorialPlanDigest(editorial), editorialPlanRevision: plan.ref.revision, editorialPlanningSnapshot: snapshot, editorialPlanningSnapshotDigest: snapshotDigest, selectedNextItemId: editorial.selectedNextItemId, editorialItemStates: states, editorialPlanEvidenceLineage: [...new Set(editorial.items.flatMap(item => item.evidenceRefs))] };
}
