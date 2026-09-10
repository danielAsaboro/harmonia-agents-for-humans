import { createHash } from "node:crypto";
import { awsRepository, recordKey, partition, DynamoTransaction } from "../dynamo";
import { assertResourceWorkspace, currentTenant, tenantSubjectId } from "../tenancy";
import { requireContentOperator } from "../authority";
import { intakeDraftKey, readIntakeDraft, readIntakeSourceRights } from "../intake/repository";
import { getActiveStrategy, readActiveStrategyRef } from "../strategy/repository";
import { strategyDigest } from "../strategyApproval";
import { sourceAnalysisDigest } from "../sourceAnalysis";
import { authorityKey, campaignRoot, currentPlan, listCurrentPlans, pointerKey, readItemState, readPlannedItem, readPlanningPolicy, scopedRef, writeCampaign } from "../campaigns/repository";
import type { AuthorityRef, PlannedItem, PlannedItemState, PlanningMaterialization, PlanningPolicy, PlanRevision } from "../campaigns/contracts";

const digest = (value: unknown) => strategyDigest(value);
export function localWeek(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const value = (key: string) => Number(parts.find(part => part.type === key)!.value);
  const date = new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return date.toISOString().slice(0, 10);
}
type CalendarCommitment = Pick<PlannedItem, "ref" | "scheduledFor" | "channel"> & { lifecycle?: Pick<PlannedItemState, "status"> };
export function calendarConflicts(candidate: CalendarCommitment, items: CalendarCommitment[], policy: PlanningPolicy): string[] {
  const peers = items.filter(item => item.ref.id !== candidate.ref.id && item.lifecycle?.status !== "cancelled");
  const week = localWeek(candidate.scheduledFor, policy.timezone);
  const weekly = peers.filter(item => localWeek(item.scheduledFor, policy.timezone) === week);
  const sameChannel = weekly.filter(item => item.channel === candidate.channel);
  const reasons: string[] = [];
  if (peers.filter(item => item.lifecycle?.status !== "completed").length >= policy.productionCapacity.maxItems) reasons.push("production capacity exceeded");
  if (weekly.length >= policy.productionCapacity.maxItemsPerWeek) reasons.push("weekly production capacity exceeded");
  if (sameChannel.length >= policy.cadenceConstraints.maxItemsPerChannelPerWeek) reasons.push("channel weekly cadence exceeded");
  if (peers.some(item => item.channel === candidate.channel && Math.abs(Date.parse(item.scheduledFor) - Date.parse(candidate.scheduledFor)) < policy.cadenceConstraints.minimumHoursBetweenItems * 3600000)) reasons.push("minimum channel spacing violated");
  return reasons;
}
export async function materializeIntake(input: { draftId: string; expectedDraftRevision: number; requestId: string }): Promise<PlanningMaterialization> {
  requireContentOperator(currentTenant());
  const receiptKey = recordKey(`${campaignRoot()}/planning_intake_receipts/${input.draftId}`);
  const identity = digest(input);
  const readReceipt = async () => { const row = await awsRepository().read(receiptKey); if (!row.present) return null; if (row.value?.identity !== identity) throw new Error("intake materialization revision or message mismatch"); return row.value!.result as PlanningMaterialization; };
  try {
    return await awsRepository().atomic(async tx => {
      const existing = await tx.read(receiptKey);
      if (existing.present) { if (existing.value?.identity !== identity) throw new Error("intake materialization revision or message mismatch"); return existing.value!.result as PlanningMaterialization; }
      const draft = await readIntakeDraft(input.draftId, tx);
      if (!draft || draft.revision !== input.expectedDraftRevision) throw new Error("stale intake draft revision");
      if (draft.answers.at(-1)?.requestId !== input.requestId) throw new Error("intake message identity mismatch");
      if (draft.state !== "ready_for_planning") throw new Error("intake is not ready for planning");
      const active = await getActiveStrategy(tx); if (!active) throw new Error("approved strategy required for planning");
      if (digest(active.ref) !== digest(draft.strategyBaseRef)) throw new Error("active strategy changed; reassess intake");
      const policy = await readPlanningPolicy(tx);
      const now = new Date().toISOString();
      let result: PlanningMaterialization;
      if (draft.disposition === "existing_plan_item") {
        if (!draft.target) throw new Error("planned item target required");
        const plan = await currentPlan(draft.target.planId, tx);
        const ref = plan.itemRefs.find(ref => ref.id === draft.target!.itemId);
        if (!ref || (plan.campaignRef?.id ?? null) !== draft.target.campaignId) throw new Error("planned target changed");
        const item = await readPlannedItem(ref, tx); const state = await readItemState(ref, tx);
        if (digest(item.strategyRef) !== digest(active.ref) || !["planned", "blocked"].includes(state.status)) throw new Error("planned item is no longer eligible");
        if (digest([...item.requestedOutputs].sort()) !== digest([...draft.requestedOutputs].sort())) throw new Error("requested outputs require a plan revision");
        result = { campaignRef: plan.campaignRef, planRef: plan.ref, itemRefs: [ref] };
        if (draft.sourceHandles.length) {
          for (const source of draft.sourceHandles) await readIntakeSourceRights(draft, source, tx);
          const proposalId = `sources-${draft.id.slice(0, 48)}`;
          tx.insert(recordKey(`${campaignRoot()}/planning_proposals/${proposalId}`), { workspaceId: draft.workspaceId, brandId: draft.brandId, state: "pending_approval", reason: "Source replacement requires an explicit new planned-item revision and evidence binding", intakeDraftId: draft.id, itemRef: ref, sourceHandles: draft.sourceHandles, sourceRights: draft.sourceRights, operatorBrief: draft.originalOperatorBrief, at: now, actor: tenantSubjectId(currentTenant()) });
          tx.put(authorityKey("planned_item_states", ref), { ...state, status: "requires_disposition", reason: `Source replacement proposal ${proposalId}`, updatedAt: now });
          result.proposalId = proposalId;
        }
      } else {
        if (!draft.requestedOutputs.length) throw new Error("selected outputs required for planned work");
        const ref = scopedRef(`plan-${draft.id.slice(0, 48)}`, 1);
        const campaign = draft.disposition === "new_initiative" ? await writeCampaign(tx, { id: `campaign-${draft.id.slice(0, 48)}`, name: draft.targetName || draft.expectedOutcome, objective: draft.expectedOutcome, strategyRef: active.ref }, 0) : null;
        const itemRef = scopedRef(`item-${draft.id.slice(0, 48)}`, 1);
        const channel = draft.requestedOutputs.some(output => output.startsWith("x_")) ? "x" : draft.requestedOutputs.includes("linkedin_post") ? "linkedin" : active.strategy.channelRoles.find(role => role.operationallySupported)?.channel;
        if (!channel) throw new Error("approved strategy has no supported channel");
        const item: PlannedItem = { ref: itemRef, workspaceId: ref.workspaceId, brandId: ref.brandId, planRef: ref, campaignRef: campaign?.ref ?? null, strategyRef: active.ref,
          name: draft.expectedOutcome, objective: draft.expectedOutcome, operatorBrief: draft.originalOperatorBrief, requestedOutputs: draft.requestedOutputs, channel, scheduledFor: now, dependencies: [], requiredAssetIds: [],
          evidence: { mode: "operator_context", operatorBrief: draft.originalOperatorBrief, contextDigest: sourceAnalysisDigest(draft.originalOperatorBrief), evidenceIds: [], factualClaimsAllowed: false }, createdAt: now };
        const peers = await plannedCalendar(tx);
        const reasons = calendarConflicts(item, peers, policy);
        if (!active.strategy.channelRoles.some(role => role.channel === channel && role.operationallySupported)) reasons.push("channel outside approved strategy");
        if (draft.requestedOutputs.some(output => !["x_post", "linkedin_post", "caption", "content_pack"].includes(output))) reasons.push("selected output requires factual source evidence");
        const plan: PlanRevision = { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, campaignRef: campaign?.ref ?? null, strategyRef: active.ref, policyRef: policy.ref, itemRefs: [itemRef], reason: draft.expectedOutcome, createdAt: now, createdBy: tenantSubjectId(currentTenant()) };
        tx.insert(authorityKey("plan_revisions", ref), plan); tx.put(pointerKey("plans", ref.id), ref);
        tx.insert(authorityKey("planned_item_revisions", itemRef), item);
        tx.insert(authorityKey("planned_item_states", itemRef), { ref: itemRef, workspaceId: ref.workspaceId, brandId: ref.brandId, status: reasons.length ? "blocked" : "planned", reason: reasons.join("; "), updatedAt: now } satisfies PlannedItemState);
        result = { campaignRef: plan.campaignRef, planRef: ref, itemRefs: plan.itemRefs };
      }
      tx.insert(receiptKey, { workspaceId: draft.workspaceId, brandId: draft.brandId, identity, result, at: now, actor: tenantSubjectId(currentTenant()) });
      tx.put(intakeDraftKey(draft.id), { ...draft, state: "dispatched", planning: result, materializedFromRevision: draft.revision, revision: draft.revision + 1, updatedAt: now });
      return result;
    });
  } catch (error) { const result = await readReceipt(); if (result) return result; throw error; }
}
type PlanningChatResult = { outcome: string; reply: string; proposalId?: string; claim?: import("./selection").PlannedClaim | null };
export async function executePlanningChat(input: { action: "advance_plan" | "manage_calendar"; message: string; requestId: string; targetName?: string }): Promise<PlanningChatResult> {
  requireContentOperator(currentTenant());
  if (!input.requestId) throw new Error("durable planning command identity required");
  const receiptKey = recordKey(`${campaignRoot()}/planning_chat_receipts/${digest([tenantSubjectId(currentTenant()), input.requestId])}`);
  const previous = await awsRepository().read(receiptKey);
  if (previous.present) { if (previous.value?.digest !== digest(input)) throw new Error("planning command identity reused"); return previous.value!.result as PlanningChatResult; }
  const audited = async (work: (tx: DynamoTransaction) => Promise<PlanningChatResult>) => {
    try { return await awsRepository().atomic(async tx => {
      const row = await tx.read(receiptKey);
      if (row.present) { if (row.value?.digest !== digest(input)) throw new Error("planning command identity reused"); return row.value!.result as PlanningChatResult; }
      const result = await work(tx);
      tx.insert(receiptKey, { workspaceId: currentTenant().workspaceId, brandId: currentTenant().brandId, digest: digest(input), input, result, at: new Date().toISOString(), actor: tenantSubjectId(currentTenant()) }); return result;
    }); } catch (error) { const row = await awsRepository().read(receiptKey); if (row.value?.digest === digest(input)) return row.value!.result as PlanningChatResult; throw error; }
  };
  const plans = await listCurrentPlans(); const items = await plannedCalendar();
  const name = input.targetName?.toLocaleLowerCase();
  const targets = items.filter(item => name && [item.name, item.ref.id, item.planRef.id, item.campaignRef?.id, `${item.planRef.id}/${item.ref.id}`].some(value => value?.toLocaleLowerCase() === name));
  if (input.action === "advance_plan" && (targets.length === 1 || (!name && plans.length === 1))) {
    const { claimNextInTransaction } = await import("./selection");
    const planId = targets[0]?.planRef.id ?? plans[0].ref.id;
    return audited(async tx => {
      const claim = await claimNextInTransaction(tx, planId, new Date().toISOString());
      return { outcome: "applied", reply: claim ? `Execution job ${claim.jobId} is bound to planned item ${claim.itemRef.id}. Its durable outbox owns dispatch.` : `Plan ${planId} has no eligible item due within current capacity. Review its schedule, dependency and asset states.`, claim };
    });
  }
  const timestamp = input.message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/)?.[0];
  if (input.action === "manage_calendar" && targets.length === 1 && timestamp) {
    return audited(async tx => {
      const result = await replanItem({ itemRef: targets[0].ref, scheduledFor: timestamp, requestId: input.requestId }, tx);
      return { ...result, reply: result.outcome === "applied" ? `Scheduled item ${result.itemRef!.id} for ${timestamp}; plan revision is durable. External Google Calendar sync requires its existing effect confirmation.` : `Saved proposal ${result.proposalId} for approval: ${result.reasons.join("; ")}.` };
    });
  }
  const proposalId = digest([tenantSubjectId(currentTenant()), input.requestId]);
  const key = recordKey(`${campaignRoot()}/planning_proposals/${proposalId}`);
  return audited(async tx => {
    const row = await tx.read(key); if (row.present && row.value?.digest !== digest(input)) throw new Error("planning command identity reused");
    if (!row.present) tx.insert(key, { workspaceId: currentTenant().workspaceId, brandId: currentTenant().brandId, input, digest: digest(input), state: "needs_details", reason: "Exact current plan/item and an unambiguous timestamp with offset are required for calendar changes", actor: tenantSubjectId(currentTenant()), at: new Date().toISOString() });
    return { outcome: "proposal", proposalId, reply: `Saved planning proposal ${proposalId}. Specify the exact planned item and an ISO date/time with timezone offset to change its schedule, or the plan to advance. ${plans.length} plan(s) and ${items.length} item(s) are available.` };
  });
}
export async function plannedCalendar(reader = awsRepository() as import("../strategy/repository").StrategyReader): Promise<Array<PlannedItem & { lifecycle: PlannedItemState }>> {
  const plans = await listCurrentPlans(reader); const items: Array<PlannedItem & { lifecycle: PlannedItemState }> = [];
  if (!plans.length) return items;
  const definitionsQuery = partition(`${campaignRoot()}/planned_item_revisions`), statesQuery = partition(`${campaignRoot()}/planned_item_states`);
  const definitions = reader instanceof DynamoTransaction ? await reader.read(definitionsQuery) : await awsRepository().query(definitionsQuery);
  const states = reader instanceof DynamoTransaction ? await reader.read(statesQuery) : await awsRepository().query(statesQuery);
  for (const plan of plans) for (const ref of plan.itemRefs) {
    const state = states.rows.find(row => row.id === `${ref.id}-v${ref.revision}`)?.value as unknown as PlannedItemState;
    const item = definitions.rows.find(row => row.id === `${ref.id}-v${ref.revision}`)?.value as unknown as PlannedItem;
    if (!state || !item || digest(state.ref) !== digest(ref) || digest(item.ref) !== digest(ref)) throw new Error("planned calendar item revision authority missing");
    assertResourceWorkspace(currentTenant(), state); assertResourceWorkspace(currentTenant(), item);
    if (state.status !== "cancelled") items.push({ ...item, lifecycle: state });
  }
  return items;
}
export async function addPlannedDeliverable(input: { planId: string; expectedRevision: number; requestId: string; name: string; operatorBrief: string; requestedOutputs: PlannedItem["requestedOutputs"]; channel: string; scheduledFor: string; dependencies: AuthorityRef[]; requiredAssetIds: string[] }) {
  requireContentOperator(currentTenant());
  if (!input.name.trim() || !input.operatorBrief.trim() || !input.requestedOutputs.length || !Number.isFinite(Date.parse(input.scheduledFor))) throw new Error("complete planned deliverable required");
  return awsRepository().atomic(async tx => {
    const receiptKey = recordKey(`${campaignRoot()}/planning_commands/${digest([tenantSubjectId(currentTenant()), input.requestId])}`);
    const receipt = await tx.read(receiptKey);
    if (receipt.present) { if (receipt.value?.digest !== digest(input)) throw new Error("planning command identity reused"); return receipt.value!.result as { planRef: AuthorityRef; itemRef: AuthorityRef }; }
    const plan = await currentPlan(input.planId, tx);
    if (plan.ref.revision !== input.expectedRevision) throw new Error("stale plan revision");
    if (strategyDigest(await readActiveStrategyRef(tx)) !== strategyDigest(plan.strategyRef)) throw new Error("active strategy changed; proposal approval required");
    const policy = await readPlanningPolicy(tx); const ref = scopedRef(`item-${digest([input.planId, input.requestId]).slice(0, 48)}`, 1); const planRef = scopedRef(plan.ref.id, plan.ref.revision + 1);
    const now = new Date().toISOString();
    for (const dependency of input.dependencies) {
      await readPlannedItem(dependency, tx);
      if (!plan.itemRefs.some(ref => digest(ref) === digest(dependency))) throw new Error("dependency must be an exact item in this plan");
    }
    const item: PlannedItem = { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, planRef, campaignRef: plan.campaignRef, strategyRef: plan.strategyRef, name: input.name, objective: input.name, operatorBrief: input.operatorBrief, requestedOutputs: input.requestedOutputs, channel: input.channel, scheduledFor: new Date(input.scheduledFor).toISOString(), dependencies: input.dependencies, requiredAssetIds: input.requiredAssetIds, evidence: { mode: "operator_context", operatorBrief: input.operatorBrief, contextDigest: sourceAnalysisDigest(input.operatorBrief), evidenceIds: [], factualClaimsAllowed: false }, createdAt: now };
    const conflicts = calendarConflicts(item, await plannedCalendar(tx), policy);
    if (conflicts.length) throw new Error(`calendar proposal required: ${conflicts.join("; ")}`);
    const active = await getActiveStrategy(tx);
    if (!active?.strategy.channelRoles.some(role => role.channel === item.channel && role.operationallySupported)) throw new Error("channel outside active strategy; proposal approval required");
    const nextPlan: PlanRevision = { ...plan, ref: planRef, itemRefs: [...plan.itemRefs, ref], reason: input.name, createdAt: now, createdBy: tenantSubjectId(currentTenant()) };
    // This deliverable has its own operator context; it never inherits an earlier item's sources.
    delete nextPlan.editorial;
    tx.insert(authorityKey("plan_revisions", planRef), nextPlan); tx.put(pointerKey("plans", planRef.id), planRef);
    tx.insert(authorityKey("planned_item_revisions", ref), item);
    tx.insert(authorityKey("planned_item_states", ref), { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, status: "planned", updatedAt: now });
    const result = { planRef, itemRef: ref };
    tx.insert(receiptKey, { workspaceId: ref.workspaceId, brandId: ref.brandId, digest: digest(input), result, at: now, actor: tenantSubjectId(currentTenant()) }); return result;
  });
}
export async function replanItem(input: { itemRef: AuthorityRef; scheduledFor: string; requestId: string }, transaction?: DynamoTransaction): Promise<{ outcome: "applied" | "proposal"; itemRef?: AuthorityRef; reasons: string[]; proposalId?: string }> {
  requireContentOperator(currentTenant());
  if (!Number.isFinite(Date.parse(input.scheduledFor))) throw new Error("explicit timestamp with offset required");
  if (!/(Z|[+-]\d\d:\d\d)$/.test(input.scheduledFor)) throw new Error("explicit timestamp with offset required");
  const commandId = createHash("sha256").update(JSON.stringify([tenantSubjectId(currentTenant()), input.requestId])).digest("hex");
  const atomic = transaction ? <T>(work: (tx: DynamoTransaction) => Promise<T>) => work(transaction) : awsRepository().atomic.bind(awsRepository());
  return atomic(async tx => {
    const receiptKey = recordKey(`${campaignRoot()}/planning_commands/${commandId}`); const prior = await tx.read(receiptKey);
    if (prior.present) { if (prior.value?.digest !== digest(input)) throw new Error("planning command identity reused"); return prior.value!.result as Awaited<ReturnType<typeof replanItem>>; }
    const item = await readPlannedItem(input.itemRef, tx); const state = await readItemState(input.itemRef, tx); const plan = await currentPlan(item.planRef.id, tx);
    if (!plan.itemRefs.some(ref => digest(ref) === digest(input.itemRef))) throw new Error("stale planned item revision");
    const policy = await readPlanningPolicy(tx); const active = await readActiveStrategyRef(tx);
    const shift = Date.parse(input.scheduledFor) - Date.parse(item.scheduledFor);
    const candidate = { ...item, scheduledFor: new Date(input.scheduledFor).toISOString(),
      ...(item.publicationWindowEndAt ? { publicationWindowEndAt: new Date(Date.parse(item.publicationWindowEndAt) + shift).toISOString() } : {}),
      ...(item.productionDeadlineAt ? { productionDeadlineAt: new Date(Date.parse(item.productionDeadlineAt) + shift).toISOString() } : {}),
    };
    const reasons = calendarConflicts(candidate, await plannedCalendar(tx), policy);
    if (plan.editorial && (Date.parse(candidate.productionDeadlineAt ?? candidate.scheduledFor) < Date.parse(plan.editorial.plan.horizonStartAt) || Date.parse(candidate.publicationWindowEndAt ?? candidate.scheduledFor) > Date.parse(plan.editorial.plan.horizonEndAt))) reasons.push("schedule outside approved planning horizon");
    if (digest(active) !== digest(item.strategyRef)) reasons.push("strategy revision changed");
    if (state.status === "completed") throw new Error("completed work is immutable");
    if (["running", "awaiting_approval"].includes(state.status) || state.approvedDigest) reasons.push("changed approved work requires disposition");
    const now = new Date().toISOString();
    let result: Awaited<ReturnType<typeof replanItem>>;
    if (reasons.length) {
      result = { outcome: "proposal", reasons, proposalId: commandId };
      tx.insert(recordKey(`${campaignRoot()}/planning_proposals/${commandId}`), { workspaceId: item.workspaceId, brandId: item.brandId, input, reasons, state: "pending_approval", at: now, actor: tenantSubjectId(currentTenant()) });
    } else {
      const planRef = scopedRef(plan.ref.id, plan.ref.revision + 1); const ref = scopedRef(item.ref.id, item.ref.revision + 1);
      tx.insert(authorityKey("planned_item_revisions", ref), { ...candidate, ref, planRef, createdAt: now });
      tx.insert(authorityKey("planned_item_states", ref), { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, status: "planned", updatedAt: now });
      tx.insert(authorityKey("plan_revisions", planRef), { ...plan, ref: planRef, itemRefs: plan.itemRefs.map(old => old.id === ref.id ? ref : old), reason: "Operator calendar change", createdAt: now, createdBy: tenantSubjectId(currentTenant()) });
      tx.put(pointerKey("plans", planRef.id), planRef); result = { outcome: "applied", itemRef: ref, reasons: [] };
    }
    tx.insert(receiptKey, { workspaceId: item.workspaceId, brandId: item.brandId, digest: digest(input), result, at: now }); return result;
  });
}
