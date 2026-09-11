import { awsRepository, recordKey, type DynamoTransaction } from "../dynamo";
import { assertResourceWorkspace, currentTenant, tenantSubjectId } from "../tenancy";
import { requireContentOperator } from "../authority";
import { strategyDigest as digest } from "../strategyApproval";
import { getActiveStrategy, readActiveStrategyRef } from "../strategy/repository";
import type { StrategyRef } from "../strategy/contracts";
import { authorityKey, campaignRoot, currentPlan, listCurrentPlans, pointerKey, readItemState, readPlannedItem, readPlanningPolicy, scopedRef, withItemProductionContext } from "../campaigns/repository";
import type { AuthorityRef, PlannedItem, PlannedItemState } from "../campaigns/contracts";
import { readIntakeDraft, readIntakeSourceRights } from "../intake/repository";
import type { IntakeDraft } from "../intake/contracts";
import { readPlannedExecutionAuthority } from "./executionAuthority";
import type { SourceInput } from "../types";
import { sourceAnalysisDigest } from "../sourceAnalysis";
import { sealOperatorInstructionContext, type OperatorInstructionContext } from "../operatorInstructions";
import { buildEditorialRebaseReview, resolveEditorialRebase, type EditorialRebaseReview, type EditorialMapping } from "./editorialRebase";
import { calendarConflicts, plannedCalendar } from "./commands";

type Guard = { itemRef: AuthorityRef; authorityDigest: string };
export interface RevisionProposal {
  workspaceId: string; brandId: string; type: "strategy_rebase" | "source_replacement";
  state: string; expectedPlanRef: AuthorityRef; targetStrategyRef: StrategyRef; policyRef: AuthorityRef;
  guarded: Guard[]; previousStates: PlannedItemState[]; input?: unknown;
  intakeDraftId?: string; intakeRevision?: number; sourceInputs?: SourceInput[]; sourceAuthority?: unknown;
  operatorBrief?: string; instructionContext?: OperatorInstructionContext; actor: string; at: string;
  editorialRebases?: EditorialRebaseReview[];
}
const proposalKey = (id: string) => recordKey(`${campaignRoot()}/planning_proposals/${id}`);
export function planningDispositionDigest(proposal: Record<string, unknown>): string {
  if (["source_replacement", "strategy_rebase"].includes(String(proposal.type))) {
    const { state: _state, decision: _decision, decidedBy: _actor, decidedAt: _at, result: _result, editorialMappings: _mappings, ...authority } = proposal;
    void _state; void _decision; void _actor; void _at; void _result; void _mappings;
    return digest(authority);
  }
  return digest(proposal.guarded);
}

/** Source selection is approval input. Retrieval and analysis remain real workflow stages. */
export async function captureReplacementSources(tx: DynamoTransaction, draft: IntakeDraft) {
  const inputs: SourceInput[] = []; const authority: unknown[] = [];
  for (const source of draft.sourceHandles) {
    const rightsAuthorizationId = await readIntakeSourceRights(draft, source, tx);
    const rights = await tx.read(recordKey(`${campaignRoot()}/source_rights/${rightsAuthorizationId}`));
    if (rights.value?.id !== rightsAuthorizationId || rights.value?.attestedBySubjectId !== draft.subjectId) throw new Error("source rights binding mismatch");
    let attachment: unknown = null;
    if (source.kind === "upload") {
      const row = await tx.read(recordKey(`workspaces/${draft.workspaceId}/chat_attachments/${source.attachmentId}`));
      if (!row.present) throw new Error("replacement attachment missing");
      assertResourceWorkspace(currentTenant(), row.value as { workspaceId: string; brandId: string });
      if (row.value?.id !== source.attachmentId || row.value?.createdByUserId !== draft.subjectId || row.value?.state !== "ready" || !/^[a-f0-9]{64}$/.test(String(row.value?.sha256))) throw new Error("replacement attachment authority incomplete");
      attachment = row.value;
    }
    inputs.push({ ...source, rightsAuthorizationId });
    authority.push({ source, rights: rights.value, attachment });
  }
  if (!inputs.length) throw new Error("replacement sources required");
  return { inputs, authority };
}

/** Called in the strategy promotion transaction; completed and claimed work keeps its authority. */
export async function proposeQueuedStrategyDispositions(tx: DynamoTransaction, targetStrategyRef: StrategyRef, targetStrategy: import("../types").ContentStrategy) {
  const plans = await listCurrentPlans(tx); if (!plans.length) return;
  if (digest(targetStrategy) !== targetStrategyRef.digest) throw new Error("current strategy required for editorial rebase proposals");
  const policy = await readPlanningPolicy(tx); const now = new Date().toISOString();
  for (const plan of plans) {
    const guarded: Guard[] = []; const previousStates: PlannedItemState[] = []; const editorialRebases: EditorialRebaseReview[] = [];
    for (const ref of plan.itemRefs) {
      const item = await readPlannedItem(ref, tx); const state = await readItemState(ref, tx);
      if (digest(item.strategyRef) === digest(targetStrategyRef) || ["completed", "cancelled"].includes(state.status)) continue;
      const authority = await readPlannedExecutionAuthority(tx, item, state); if (authority.claimed) continue;
      const editorial = buildEditorialRebaseReview(item, targetStrategy); if (editorial) editorialRebases.push(editorial);
      // An exact new active revision supersedes older, now stale pending decisions.
      if (state.dispositionProposalId) {
        const old = await tx.read(proposalKey(state.dispositionProposalId));
        if (old.value?.state === "pending_approval") tx.put(proposalKey(state.dispositionProposalId), { ...old.value, state: "superseded" });
      }
      guarded.push({ itemRef: ref, authorityDigest: authority.digest });
      previousStates.push({ ...state, status: state.status === "requires_disposition" ? "blocked" : state.status });
    }
    if (!guarded.length) continue;
    const id = digest(["strategy_rebase", plan.ref, targetStrategyRef]);
    const proposal: RevisionProposal = { workspaceId: plan.workspaceId, brandId: plan.brandId, type: "strategy_rebase", state: "pending_approval", expectedPlanRef: plan.ref, targetStrategyRef, policyRef: policy.ref, guarded, previousStates, actor: tenantSubjectId(currentTenant()), at: now };
    tx.insert(proposalKey(id), { ...proposal, editorialRebases });
    for (const previous of previousStates) tx.put(authorityKey("planned_item_states", previous.ref), { ...previous, status: "requires_disposition", dispositionProposalId: id, reason: "Active strategy changed; approve a rebase or cancel queued work", updatedAt: now });
  }
}

export async function proposeSourceReplacement(tx: DynamoTransaction, draft: IntakeDraft, item: PlannedItem, state: PlannedItemState, expectedPlanRef: AuthorityRef) {
  const execution = await readPlannedExecutionAuthority(tx, item, state);
  if (execution.claimed || !["planned", "blocked"].includes(state.status) || state.dispositionProposalId) throw new Error("source replacement requires unclaimed eligible work");
  const sources = await captureReplacementSources(tx, draft); const policy = await readPlanningPolicy(tx);
  const affected = new Map([[digest(item.ref), { item, state, execution }]]);
  const calendar = await plannedCalendar(tx, true);
  let grew = true;
  while (grew) {
    grew = false;
    for (const dependent of calendar.filter(candidate => candidate.planRef.id === expectedPlanRef.id)) {
      if (affected.has(digest(dependent.ref)) || !dependent.dependencies.some(ref => affected.has(digest(ref)))) continue;
      const authority = await readPlannedExecutionAuthority(tx, dependent, dependent.lifecycle);
      if (authority.claimed || !["planned", "blocked"].includes(dependent.lifecycle.status) || dependent.lifecycle.dispositionProposalId) throw new Error("dependent execution authority prevents source replacement");
      affected.set(digest(dependent.ref), { item: dependent, state: dependent.lifecycle, execution: authority }); grew = true;
    }
  }
  const id = digest(["source_replacement", draft.id, draft.revision, item.ref]);
  const proposal: RevisionProposal = { workspaceId: draft.workspaceId, brandId: draft.brandId, type: "source_replacement", state: "pending_approval", expectedPlanRef, targetStrategyRef: item.strategyRef, policyRef: policy.ref, guarded: [{ itemRef: item.ref, authorityDigest: execution.digest }], previousStates: [state], intakeDraftId: draft.id, intakeRevision: draft.revision + 1, sourceInputs: sources.inputs, sourceAuthority: sources.authority, operatorBrief: draft.originalOperatorBrief, actor: tenantSubjectId(currentTenant()), at: new Date().toISOString() };
  proposal.guarded = [...affected.values()].map(value => ({ itemRef: value.item.ref, authorityDigest: value.execution.digest }));
  proposal.instructionContext = sealOperatorInstructionContext({ draftId: draft.id, revision: draft.revision, originalOperatorBrief: draft.originalOperatorBrief, answers: draft.answers });
  proposal.operatorBrief = proposal.instructionContext.resolvedInstructions;
  proposal.previousStates = [...affected.values()].map(value => value.state);
  tx.insert(proposalKey(id), { ...proposal, itemRef: item.ref, sourceHandles: draft.sourceHandles, sourceRights: draft.sourceRights, reason: "Review exact replacement source selection; retrieval and analysis must complete before production" });
  for (const value of affected.values()) tx.put(authorityKey("planned_item_states", value.item.ref), { ...value.state, status: "requires_disposition", dispositionProposalId: id, reason: `Source replacement proposal ${id}`, updatedAt: proposal.at });
  return id;
}

export type PlanningDecision = "keep_existing_execution" | "rebase_to_current_strategy" | "cancel" | "reject" | "accept_source_replacement";
export async function disposePlanningProposal(input: { proposalId: string; expectedAuthorityDigest: string; decision: PlanningDecision; requestId: string; editorialMappings?: EditorialMapping[] }) {
  requireContentOperator(currentTenant());
  return awsRepository().atomic(async tx => {
    const receiptKey = recordKey(`${campaignRoot()}/planning_commands/${digest([tenantSubjectId(currentTenant()), input.requestId])}`);
    const prior = await tx.read(receiptKey);
    if (prior.present) { if (prior.value?.digest !== digest(input)) throw new Error("planning disposition identity reused"); return prior.value!.result; }
    const key = proposalKey(input.proposalId); const row = await tx.read(key); const raw = row.value;
    if (!raw || raw.state !== "pending_approval") throw new Error("pending planning disposition required");
    assertResourceWorkspace(currentTenant(), raw as { workspaceId: string; brandId: string });
    const guarded = raw.guarded as Guard[];
    if (!guarded?.length || planningDispositionDigest(raw) !== input.expectedAuthorityDigest) throw new Error("planning disposition authority mismatch");
    const items: PlannedItem[] = [];
    for (const guard of guarded) {
      const item = await readPlannedItem(guard.itemRef, tx); const state = await readItemState(guard.itemRef, tx);
      if (state.dispositionProposalId !== input.proposalId || (await readPlannedExecutionAuthority(tx, item, state)).digest !== guard.authorityDigest) throw new Error("execution authority changed; reconcile and request a current disposition");
      items.push(item);
    }
    const now = new Date().toISOString(); let result: Record<string, unknown>;
    if (["calendar_change", "measurement_change"].includes(String(raw.type))) {
      if (input.decision !== "keep_existing_execution") throw new Error("unsupported planning disposition");
      for (const item of items) {
        const { dispositionProposalId: _id, ...state } = await readItemState(item.ref, tx); void _id;
        tx.put(authorityKey("planned_item_states", item.ref), { ...state, reason: "Calendar proposal declined; existing execution retained", updatedAt: now });
      }
      result = { outcome: "kept_existing_execution", proposalId: input.proposalId };
    } else {
      const proposal = raw as unknown as RevisionProposal;
      if (!["source_replacement", "strategy_rebase"].includes(proposal.type)) throw new Error("unsupported planning disposition");
      const plan = await currentPlan(proposal.expectedPlanRef.id, tx);
      if (items.some(item => !plan.itemRefs.some(ref => digest(ref) === digest(item.ref)))) throw new Error("stale planned item revision");
      if (digest(await readActiveStrategyRef(tx)) !== digest(proposal.targetStrategyRef)) throw new Error("active strategy changed; stale planning disposition");
      for (const item of items) if ((await readPlannedExecutionAuthority(tx, item, await readItemState(item.ref, tx))).claimed) throw new Error("claimed execution cannot be revised");
      const accepting = input.decision === (proposal.type === "strategy_rebase" ? "rebase_to_current_strategy" : "accept_source_replacement");
      if (accepting && digest(plan.ref) !== digest(proposal.expectedPlanRef)) throw new Error("stale plan revision");
      if (!accepting && !["cancel", "reject", "keep_existing_execution"].includes(input.decision)) throw new Error("unsupported planning disposition");
      if (proposal.type === "strategy_rebase" && input.decision === "keep_existing_execution") throw new Error("old strategy execution cannot be retained without a rebase approval");
      if (!accepting) {
        const terminal = input.decision === "cancel" || proposal.type === "strategy_rebase";
        for (const previous of proposal.previousStates) {
          const { dispositionProposalId: _id, ...state } = previous; void _id;
          tx.put(authorityKey("planned_item_states", previous.ref), { ...state, status: terminal ? "cancelled" : previous.status, reason: terminal ? "Operator cancelled queued work" : "Source replacement declined; existing source selection retained", updatedAt: now });
        }
        result = { outcome: terminal ? "cancelled" : "kept_existing_execution", proposalId: input.proposalId };
      } else {
        const policy = await readPlanningPolicy(tx);
        if (digest(policy.ref) !== digest(proposal.policyRef)) throw new Error("planning policy changed; new approval required");
        const active = await getActiveStrategy(tx); if (!active) throw new Error("active strategy required");
        const mappings = input.editorialMappings ?? [];
        if (mappings.some(mapping => !(proposal.editorialRebases ?? []).some(review => digest(review.itemRef) === digest(mapping.itemRef)))) throw new Error("editorial mapping is outside reviewed planned items");
        let sources: Awaited<ReturnType<typeof captureReplacementSources>> | undefined;
        if (proposal.type === "source_replacement") {
          const draft = await readIntakeDraft(proposal.intakeDraftId!, tx);
          if (!draft || draft.revision !== proposal.intakeRevision || draft.planning?.proposalId !== input.proposalId) throw new Error("source intake revision changed");
          sources = await captureReplacementSources(tx, draft);
          if (digest(sources.inputs) !== digest(proposal.sourceInputs) || digest(sources.authority) !== digest(proposal.sourceAuthority)) throw new Error("source evidence changed; new approval required");
        }
        const calendar = await plannedCalendar(tx, true);
        // Dependents are revised too so their exact prerequisite references remain reachable.
        const affected = new Map(items.map(item => [digest(item.ref), item]));
        let grew = true;
        while (grew) { grew = false; for (const item of calendar.filter(i => i.planRef.id === plan.ref.id)) if (!affected.has(digest(item.ref)) && item.dependencies.some(ref => affected.has(digest(ref)))) {
          const execution = await readPlannedExecutionAuthority(tx, item, item.lifecycle);
          if (execution.claimed || ["completed", "cancelled"].includes(item.lifecycle.status)) throw new Error("dependent execution authority prevents revision");
          throw new Error("dependent item revision changed; new exact plan approval required");
        } }
        const planRef = scopedRef(plan.ref.id, plan.ref.revision + 1);
        const replacements = new Map([...affected.values()].map(item => [digest(item.ref), scopedRef(item.ref.id, item.ref.revision + 1)]));
        for (const item of affected.values()) {
          if (!active.strategy.channelRoles.some(role => role.channel === item.channel && role.operationallySupported)) throw new Error("channel outside current strategy");
          const conflicts = calendarConflicts(item, calendar, policy); if (conflicts.length) throw new Error(`calendar constraints changed: ${conflicts.join("; ")}`);
          const { lifecycle: _lifecycle, ...definition } = item as PlannedItem & { lifecycle?: PlannedItemState }; void _lifecycle;
          let evidence = definition.evidence; let productionContext = definition.productionContext;
          let editorialItem: import("../types").EditorialPlanItem | null = null;
          if (sources && digest(item.ref) === digest(raw.itemRef)) {
            evidence = { mode: "source_intake", sourceInputs: sources.inputs, authorityDigest: sourceAnalysisDigest(sources.authority) };
            productionContext = { mode: "source_intake", policyRef: policy.ref, intakeDraftId: proposal.intakeDraftId!, intakeRevision: proposal.intakeRevision!, sourceInputs: sources.inputs, sourceAuthority: sources.authority };
          } else if (evidence.mode === "source_backed" && productionContext.mode === "source_backed") {
            if (proposal.type === "strategy_rebase") editorialItem = resolveEditorialRebase(item, active.strategy, proposal.editorialRebases ?? [], mappings);
            evidence = { ...evidence, sourceBinding: { ...evidence.sourceBinding, strategyRef: proposal.targetStrategyRef } };
            productionContext = { ...productionContext, ...(editorialItem ? { item: editorialItem } : {}), snapshot: { ...productionContext.snapshot, sourceBinding: evidence.sourceBinding }, plan: { ...productionContext.plan, approvedStrategyDigest: proposal.targetStrategyRef.digest } };
          }
          const ref = replacements.get(digest(item.ref))!;
          const replacingSources = sources && digest(item.ref) === digest(raw.itemRef);
          const next = withItemProductionContext({ ...definition, ...(editorialItem ? { name: editorialItem.campaignTheme, objective: editorialItem.objective } : {}), ...(replacingSources ? { operatorBrief: proposal.operatorBrief!, originalOperatorBrief: proposal.instructionContext!.originalOperatorBrief, instructionContext: proposal.instructionContext } : {}), ref, planRef, strategyRef: proposal.targetStrategyRef, dependencies: item.dependencies.map(ref => replacements.get(digest(ref)) ?? ref), evidence, productionContext, createdAt: now });
          tx.insert(authorityKey("planned_item_revisions", ref), next);
          tx.insert(authorityKey("planned_item_states", ref), { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, status: "planned", updatedAt: now });
        }
        tx.insert(authorityKey("plan_revisions", planRef), { ...plan, ref: planRef, strategyRef: proposal.targetStrategyRef, policyRef: policy.ref, itemRefs: plan.itemRefs.map(ref => replacements.get(digest(ref)) ?? ref), reason: `Operator approved ${proposal.type}`, createdAt: now, createdBy: tenantSubjectId(currentTenant()) });
        tx.put(pointerKey("plans", planRef.id), planRef);
        result = { outcome: sources ? "sources_replaced" : "rebased", proposalId: input.proposalId, planRef, itemRefs: [...replacements.values()] };
      }
    }
    tx.put(key, { ...raw, state: ["rebased", "sources_replaced"].includes(String(result.outcome)) ? "approved" : "declined", decision: input.decision, ...(input.editorialMappings ? { editorialMappings: input.editorialMappings } : {}), decidedBy: tenantSubjectId(currentTenant()), decidedAt: now, result });
    tx.insert(receiptKey, { workspaceId: currentTenant().workspaceId, brandId: currentTenant().brandId, digest: digest(input), result }); return result;
  });
}
