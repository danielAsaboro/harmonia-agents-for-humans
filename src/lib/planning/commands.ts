import { createHash } from "node:crypto";
import { awsRepository, recordKey, partition, DynamoTransaction } from "../dynamo";
import { assertResourceWorkspace, currentTenant, tenantSubjectId } from "../tenancy";
import { requireContentOperator } from "../authority";
import { intakeDraftKey, readIntakeDraft } from "../intake/repository";
import { proposeSourceReplacement } from "./dispositions";
export { disposePlanningProposal } from "./dispositions";
import { getActiveStrategy, readActiveStrategyRef } from "../strategy/repository";
import { strategyDigest } from "../strategyApproval";
import { sourceAnalysisDigest } from "../sourceAnalysis";
import { authorityKey, campaignRoot, currentPlan, listCurrentPlans, listPlanningAssets, pointerKey, readItemState, readPlannedItem, readPlanningPolicy, scopedRef, writeCampaign, withItemProductionContext, assertItemProductionContext, readCampaign } from "../campaigns/repository";
import { readPlannedExecutionAuthority } from "./executionAuthority";
import type { AuthorityRef, PlannedItem, PlannedItemState, PlanningMaterialization, PlanningPolicy, PlanRevision } from "../campaigns/contracts";
import { configureMeasurementSchema, pinMeasurement } from "../learning/contracts";
import { sealOperatorInstructionContext } from "../operatorInstructions";

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
          result.proposalId = await proposeSourceReplacement(tx, draft, item, state, plan.ref);
        }
      } else {
        if (!draft.requestedOutputs.length) throw new Error("selected outputs required for planned work");
        const ref = scopedRef(`plan-${draft.id.slice(0, 48)}`, 1);
        const campaign = draft.disposition === "new_initiative" ? await writeCampaign(tx, { id: `campaign-${draft.id.slice(0, 48)}`, name: draft.targetName || draft.expectedOutcome, objective: draft.expectedOutcome, strategyRef: active.ref }, 0) : null;
        const itemRef = scopedRef(`item-${draft.id.slice(0, 48)}`, 1);
        const instructionContext = sealOperatorInstructionContext({ draftId: draft.id, revision: draft.revision, originalOperatorBrief: draft.originalOperatorBrief, answers: draft.answers });
        const channel = draft.requestedOutputs.some(output => output.startsWith("x_")) ? "x" : draft.requestedOutputs.includes("linkedin_post") ? "linkedin" : active.strategy.channelRoles.find(role => role.operationallySupported)?.channel;
        if (!channel) throw new Error("approved strategy has no supported channel");
        const item: PlannedItem = withItemProductionContext({ ref: itemRef, workspaceId: ref.workspaceId, brandId: ref.brandId, planRef: ref, campaignRef: campaign?.ref ?? null, strategyRef: active.ref,
          name: draft.expectedOutcome, objective: draft.expectedOutcome, operatorBrief: instructionContext.resolvedInstructions, originalOperatorBrief: draft.originalOperatorBrief, instructionContext, requestedOutputs: draft.requestedOutputs, channel, scheduledFor: now, dependencies: [], requiredAssetIds: [],
          evidence: { mode: "operator_context", operatorBrief: instructionContext.resolvedInstructions, contextDigest: sourceAnalysisDigest(instructionContext.resolvedInstructions), evidenceIds: [], factualClaimsAllowed: false, originalOperatorBrief: draft.originalOperatorBrief, instructionContext }, productionContext: { mode: "operator_context", policyRef: policy.ref }, createdAt: now });
        const peers = await plannedCalendar(tx);
        const reasons = calendarConflicts(item, peers, policy);
        if (!active.strategy.channelRoles.some(role => role.channel === channel && role.operationallySupported)) reasons.push("channel outside approved strategy");
        // Operator context may authorize original creative media, but never factual
        // claims or source-derived clips. Source-backed outputs retain their
        // evidence requirement in the production contracts.
        if (draft.requestedOutputs.some(output => !["x_post", "linkedin_post", "caption", "social_image", "generated_video", "generated_music", "content_pack"].includes(output))) reasons.push("selected output requires factual source evidence");
        const plan: PlanRevision = { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, campaignRef: campaign?.ref ?? null, strategyRef: active.ref, policyRef: policy.ref, itemRefs: [itemRef], reason: draft.expectedOutcome, createdAt: now, createdBy: tenantSubjectId(currentTenant()) };
        tx.insert(authorityKey("plan_revisions", ref), plan); tx.put(pointerKey("plans", ref.id), ref);
        tx.insert(authorityKey("planned_item_revisions", itemRef), item);
        tx.insert(authorityKey("planned_item_states", itemRef), { ref: itemRef, workspaceId: ref.workspaceId, brandId: ref.brandId, status: reasons.length ? "blocked" : "planned", reason: reasons.join("; "), updatedAt: now } satisfies PlannedItemState);
        result = { campaignRef: plan.campaignRef, planRef: ref, itemRefs: plan.itemRefs };
      }
      tx.insert(receiptKey, { workspaceId: draft.workspaceId, brandId: draft.brandId, identity, result, at: now, actor: tenantSubjectId(currentTenant()) });
      const instructionContext = sealOperatorInstructionContext({ draftId: draft.id, revision: draft.revision, originalOperatorBrief: draft.originalOperatorBrief, answers: draft.answers });
      tx.put(intakeDraftKey(draft.id), { ...draft, instructionContext, state: "dispatched", planning: result, materializedFromRevision: draft.revision, revision: draft.revision + 1, updatedAt: now });
      return result;
    });
  } catch (error) { const result = await readReceipt(); if (result) return result; throw error; }
}
type PlanningChatResult = { outcome: string; reply: string; proposalId?: string; claim?: import("./selection").PlannedClaim | null; planRef?: AuthorityRef; itemRef?: AuthorityRef };
type PlanningChatInput = {
  action: "advance_plan" | "manage_calendar" | "append_deliverable";
  message: string;
  requestId: string;
  targetName?: string;
  deliverableName?: string;
  scheduledFor?: string;
  requestedOutputs?: PlannedItem["requestedOutputs"];
  channel?: string;
  dependencyItemIds?: string[];
  requiredAssetIds?: string[];
  sourceUrls?: string[];
  attachmentIds?: string[];
  appendParseReceipt?: { grammarVersion: "append-v1"; normalizedText: string; consumedText: string } | null;
  clarifyingQuestion?: string;
};
const APPEND_CORE_GRAMMAR = String.raw`(?<verb>add|append|schedule)\s+(?:a|an)\s+(?<platform>x|twitter|linkedin)\s+(?<kind>post|thread|article)\s+(?:called|named)\s+"(?<name>[^"]+)"\s+to\s+(?<targetType>campaign|plan)\s+"(?<target>[^"]+)"\s+at\s+(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))`;
const APPEND_FULL_GRAMMAR = new RegExp(String.raw`^${APPEND_CORE_GRAMMAR}(?:,\s+only\s+after\s+(?<dependency>[A-Za-z0-9][A-Za-z0-9_.:-]{0,199})\s+is\s+completed)?(?:,\s+(?:using|requiring|requires)\s+asset\s+"(?<asset>[^"]+)")?(?:,\s+using\s+(?<source>https?:\/\/[^\s<>"']*[A-Za-z0-9/_#=&%-]))?\.?$`, "i");
const normalizeAppendText = (message: string) => message.normalize("NFKC").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
export const appendMessageSourceUrls = (message: string) => [...normalizeAppendText(message).matchAll(/https?:\/\/[^\s<>"']+/gi)]
  .map(match => match[0].replace(/[.,;:!?)\]}]+$/, ""));
type ExactAppendSyntax = { normalizedText: string; targetName: string; deliverableName: string; scheduledFor: string; dependencyItemIds: string[]; requiredAssetIds: string[]; sourceUrls: string[]; requestedOutputs: PlannedItem["requestedOutputs"]; channel: string };
export function parseExactAppendSyntax(message: string): ExactAppendSyntax | null {
  const normalizedText = normalizeAppendText(message);
  const groups = APPEND_FULL_GRAMMAR.exec(normalizedText)?.groups;
  if (!groups) return null;
  const platform = ["x", "twitter"].includes(groups.platform.toLocaleLowerCase()) ? "x" : "linkedin";
  const output = ({ "x/post": "x_post", "x/thread": "x_thread", "linkedin/post": "linkedin_post", "linkedin/article": "blog_article" } as const)[`${platform}/${groups.kind.toLocaleLowerCase()}` as "x/post" | "x/thread" | "linkedin/post" | "linkedin/article"];
  if (!output) return null;
  return {
    normalizedText, targetName: groups.target.trim(), deliverableName: groups.name.trim(), scheduledFor: groups.timestamp,
    dependencyItemIds: groups.dependency ? [groups.dependency] : [], requiredAssetIds: groups.asset ? [groups.asset.trim()] : [],
    sourceUrls: groups.source ? [groups.source] : [], requestedOutputs: [output], channel: platform,
  };
}
const sameConstraintSet = (left: string[], right: string[]) => digest([...new Set(left)].sort()) === digest([...new Set(right)].sort());
export async function executePlanningChat(input: PlanningChatInput): Promise<PlanningChatResult> {
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
  const targets = items.filter(item => name && [item.name, item.ref.id, `${item.planRef.id}/${item.ref.id}`].some(value => value?.toLocaleLowerCase() === name));
  const planTargets = plans.filter(plan => name === plan.ref.id.toLocaleLowerCase());
  const campaignRefs = [...new Map(plans.flatMap(plan => plan.campaignRef ? [[`${plan.campaignRef.id}:v${plan.campaignRef.revision}`, plan.campaignRef] as const] : [])).values()];
  const campaignTargets = [];
  for (const ref of campaignRefs) { const campaign = await readCampaign(ref); if (name && [ref.id, campaign.name].some(value => value.toLocaleLowerCase() === name)) campaignTargets.push(ref); }
  const scopes = [
    ...targets.map(item => ({ planIds: [item.planRef.id], itemId: item.ref.id })),
    ...planTargets.map(plan => ({ planIds: [plan.ref.id], itemId: undefined })),
    ...campaignTargets.map(campaign => ({ planIds: plans.filter(plan => plan.campaignRef?.id === campaign.id).map(plan => plan.ref.id).sort(), itemId: undefined })),
    ...(!name && plans.length === 1 ? [{ planIds: [plans[0].ref.id], itemId: undefined }] : []),
  ];
  const appendConstraintIssues: string[] = [];
  if (input.action === "append_deliverable") {
    const dependencyItemIds = [...new Set((input.dependencyItemIds ?? []).map(id => id.trim()).filter(Boolean))];
    const requiredAssetIds = [...new Set((input.requiredAssetIds ?? []).map(id => id.trim()).filter(Boolean))];
    const sourceUrls = [...new Set((input.sourceUrls ?? []).map(url => url.trim()).filter(Boolean))];
    const attachmentIds = [...new Set((input.attachmentIds ?? []).map(id => id.trim()).filter(Boolean))];
    const exactSyntax = parseExactAppendSyntax(input.message);
    if (!sameConstraintSet(appendMessageSourceUrls(input.message), sourceUrls)) appendConstraintIssues.push("source URL constraints were not preserved exactly by routing");
    if (!exactSyntax) appendConstraintIssues.push("append request contains an unsupported or unconsumed clause");
    else {
      if (input.targetName?.trim() !== exactSyntax.targetName || input.deliverableName?.trim() !== exactSyntax.deliverableName || input.scheduledFor !== exactSyntax.scheduledFor) appendConstraintIssues.push("core append fields do not match the fully consumed request");
      if (!sameConstraintSet(exactSyntax.dependencyItemIds, dependencyItemIds)) appendConstraintIssues.push("dependency constraints do not match the fully consumed request");
      if (!sameConstraintSet(exactSyntax.requiredAssetIds, requiredAssetIds)) appendConstraintIssues.push("asset constraints do not match the fully consumed request");
      if (!sameConstraintSet(exactSyntax.sourceUrls, sourceUrls)) appendConstraintIssues.push("source URL constraints do not match the fully consumed request");
      if (!sameConstraintSet(exactSyntax.requestedOutputs, input.requestedOutputs ?? []) || input.channel !== exactSyntax.channel) appendConstraintIssues.push("output/channel constraints do not match the fully consumed request");
      if (input.appendParseReceipt && (input.appendParseReceipt.grammarVersion !== "append-v1" || input.appendParseReceipt.normalizedText !== exactSyntax.normalizedText || input.appendParseReceipt.consumedText !== exactSyntax.normalizedText)) appendConstraintIssues.push("append parse receipt does not prove full normalized input consumption");
    }
    if (!exactSyntax && dependencyItemIds.length) appendConstraintIssues.push("dependency constraints could not be verified against a fully consumed request");
    if (!exactSyntax && requiredAssetIds.length) appendConstraintIssues.push("asset constraints could not be verified against a fully consumed request");
    if (sourceUrls.some(url => { try { return !["http:", "https:"].includes(new URL(url).protocol); } catch { return true; } })) appendConstraintIssues.push("source URLs are invalid");
    if (sourceUrls.length) appendConstraintIssues.push("source URLs require source-rights and evidence binding before a plan item can be appended");
    if (attachmentIds.length) appendConstraintIssues.push("attachments require source-rights and evidence binding before a plan item can be appended");
    const appendPlanIds = new Set([
      ...planTargets.map(plan => plan.ref.id),
      ...campaignTargets.flatMap(campaign => plans.filter(plan => plan.campaignRef?.id === campaign.id && plan.campaignRef.revision === campaign.revision).map(plan => plan.ref.id)),
    ]);
    const plan = appendPlanIds.size === 1 ? plans.find(plan => plan.ref.id === [...appendPlanIds][0]) : undefined;
    const dependencyRefs: AuthorityRef[] = [];
    let dependencyResolutionFailed = false;
    for (const dependencyName of dependencyItemIds) {
      const normalized = dependencyName.toLocaleLowerCase();
      const matches = items.filter(item => item.planRef.id === plan?.ref.id && [item.name, item.ref.id, `${item.ref.id}:v${item.ref.revision}`].some(value => value.toLocaleLowerCase() === normalized));
      if (matches.length !== 1) dependencyResolutionFailed = true;
      else dependencyRefs.push(matches[0].ref);
    }
    if (dependencyResolutionFailed) appendConstraintIssues.push("dependency item IDs must resolve exactly once inside the selected plan");
    const planningAssets = await listPlanningAssets();
    if (requiredAssetIds.some(id => !planningAssets.some(asset => asset.id === id))) appendConstraintIssues.push("required asset IDs must resolve in this workspace");
    const channel = input.channel
      ?? (input.requestedOutputs?.some(output => output.startsWith("x_")) ? "x"
        : input.requestedOutputs?.includes("linkedin_post") ? "linkedin"
          : undefined);
    const complete = plan && input.deliverableName?.trim() && input.scheduledFor
      && /(?:Z|[+-]\d{2}:\d{2})$/.test(input.scheduledFor) && Number.isFinite(Date.parse(input.scheduledFor))
      && input.requestedOutputs?.length && channel && !dependencyResolutionFailed && appendConstraintIssues.length === 0;
    if (complete) {
      return audited(async tx => {
        const result = await addPlannedDeliverable({
          planId: plan.ref.id, expectedRevision: plan.ref.revision, requestId: input.requestId,
          name: input.deliverableName!.trim(), operatorBrief: input.message,
          requestedOutputs: input.requestedOutputs!, channel, scheduledFor: input.scheduledFor!,
          dependencies: [...new Map(dependencyRefs.map(ref => [digest(ref), ref])).values()],
          requiredAssetIds,
        }, tx);
        return {
          outcome: "applied", ...result,
          reply: `Added ${input.deliverableName!.trim()} as planned item ${result.itemRef.id} on plan ${result.planRef.id} revision ${result.planRef.revision}, scheduled for ${new Date(input.scheduledFor!).toISOString()}.`,
        };
      });
    }
  }
  if (input.action === "advance_plan" && scopes.length === 1) {
    const { claimNextInTransaction } = await import("./selection");
    const scope = scopes[0];
    return audited(async tx => {
      let claim = null;
      for (const planId of scope.planIds) { claim = await claimNextInTransaction(tx, planId, new Date().toISOString(), scope.itemId); if (claim) break; }
      return { outcome: "applied", reply: claim ? `Execution job ${claim.jobId} is bound to planned item ${claim.itemRef.id}. Its durable outbox owns dispatch.` : `The selected scope has no eligible item due within current capacity. Review its schedule, dependency and asset states.`, claim };
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
    const append = input.action === "append_deliverable";
    const reason = append
      ? [...appendConstraintIssues, "Exactly one current campaign or plan, a deliverable name, supported output/channel, explicit timestamp with offset, and unambiguous dependencies/assets are required"].join("; ")
      : "Exact current plan/item and an unambiguous timestamp with offset are required for calendar changes";
    if (!row.present) tx.insert(key, { workspaceId: currentTenant().workspaceId, brandId: currentTenant().brandId, input, digest: digest(input), state: "needs_details", reason, actor: tenantSubjectId(currentTenant()), at: new Date().toISOString() });
    return { outcome: "proposal", proposalId, reply: append
      ? `Saved planning proposal ${proposalId}. ${appendConstraintIssues.length ? `${appendConstraintIssues.join("; ")}. No plan revision was created. ` : ""}Specify exactly one current campaign or plan, the deliverable name and outputs, and an ISO date/time with timezone offset. Dependency names or IDs and required asset IDs must resolve inside that plan and workspace. ${plans.length} plan(s) and ${items.length} item(s) are available.`
      : `Saved planning proposal ${proposalId}. Specify the exact planned item and an ISO date/time with timezone offset to change its schedule, or the plan to advance. ${plans.length} plan(s) and ${items.length} item(s) are available.` };
  });
}
export async function plannedCalendar(reader = awsRepository() as import("../strategy/repository").StrategyReader, includeCancelled = false): Promise<Array<PlannedItem & { lifecycle: PlannedItemState }>> {
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
    assertItemProductionContext(item);
    if (includeCancelled || state.status !== "cancelled") items.push({ ...item, lifecycle: state });
  }
  return items;
}

/** Planning proposals are durable review records, never inferred from current items. */
export async function listPlanningProposals(): Promise<Array<Record<string, unknown>>> {
  const rows = await awsRepository().query(partition(`${campaignRoot()}/planning_proposals`));
  return rows.rows.map(row => ({ id: row.id, ...(row.value as Record<string, unknown>) }));
}
export async function addPlannedDeliverable(input: { planId: string; expectedRevision: number; requestId: string; name: string; operatorBrief: string; requestedOutputs: PlannedItem["requestedOutputs"]; channel: string; scheduledFor: string; dependencies: AuthorityRef[]; requiredAssetIds: string[]; measurements?: PlannedItem["measurements"] }, transaction?: DynamoTransaction) {
  requireContentOperator(currentTenant());
  if (!input.requestId || !input.name.trim() || !input.operatorBrief.trim() || !input.requestedOutputs.length || !Number.isFinite(Date.parse(input.scheduledFor)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.scheduledFor)) throw new Error("complete planned deliverable required");
  const atomic = transaction ? <T>(work: (tx: DynamoTransaction) => Promise<T>) => work(transaction) : awsRepository().atomic.bind(awsRepository());
  return atomic(async tx => {
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
    const planningAssets = await listPlanningAssets(tx);
    if (input.requiredAssetIds.some(id => !planningAssets.some(asset => asset.id === id))) throw new Error("required asset must exist in this workspace");
    const item: PlannedItem = withItemProductionContext({ ref, workspaceId: ref.workspaceId, brandId: ref.brandId, planRef, campaignRef: plan.campaignRef, strategyRef: plan.strategyRef, name: input.name, objective: input.name, operatorBrief: input.operatorBrief, requestedOutputs: input.requestedOutputs, channel: input.channel, scheduledFor: new Date(input.scheduledFor).toISOString(), dependencies: input.dependencies, requiredAssetIds: input.requiredAssetIds, measurements: input.measurements, evidence: { mode: "operator_context", operatorBrief: input.operatorBrief, contextDigest: sourceAnalysisDigest(input.operatorBrief), evidenceIds: [], factualClaimsAllowed: false }, productionContext: { mode: "operator_context", policyRef: policy.ref }, createdAt: now });
    const conflicts = calendarConflicts(item, await plannedCalendar(tx), policy);
    if (conflicts.length) throw new Error(`calendar proposal required: ${conflicts.join("; ")}`);
    const active = await getActiveStrategy(tx);
    if (!active?.strategy.channelRoles.some(role => role.channel === item.channel && role.operationallySupported)) throw new Error("channel outside active strategy; proposal approval required");
    const nextPlan: PlanRevision = { ...plan, ref: planRef, itemRefs: [...plan.itemRefs, ref], reason: input.name, createdAt: now, createdBy: tenantSubjectId(currentTenant()) };
    tx.insert(authorityKey("plan_revisions", planRef), nextPlan); tx.put(pointerKey("plans", planRef.id), planRef);
    tx.insert(authorityKey("planned_item_revisions", ref), item);
    tx.insert(authorityKey("planned_item_states", ref), { ref, workspaceId: ref.workspaceId, brandId: ref.brandId, status: "planned", updatedAt: now });
    const result = { planRef, itemRef: ref };
    tx.insert(receiptKey, { workspaceId: ref.workspaceId, brandId: ref.brandId, digest: digest(input), result, at: now, actor: tenantSubjectId(currentTenant()) }); return result;
  });
}
export async function configurePlannedMeasurement(raw: import("zod").z.infer<typeof configureMeasurementSchema>) {
  requireContentOperator(currentTenant());
  const input = configureMeasurementSchema.parse(raw);
  return awsRepository().atomic(async tx => {
    const item = await readPlannedItem(input.itemRef, tx);
    return replanItem({ itemRef: input.itemRef, scheduledFor: item.scheduledFor, requestId: input.requestId, measurementChange: input }, tx);
  });
}
export async function replanItem(input: { itemRef: AuthorityRef; scheduledFor: string; requestId: string; measurementChange?: import("zod").z.infer<typeof configureMeasurementSchema> }, transaction?: DynamoTransaction): Promise<{ outcome: "applied" | "proposal"; itemRef?: AuthorityRef; reasons: string[]; proposalId?: string }> {
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
    if (input.measurementChange && (digest(input.measurementChange.expectedPlanRef) !== digest(plan.ref) || digest(input.measurementChange.strategyRef) !== digest(item.strategyRef))) throw new Error("stale measurement plan or strategy revision");
    const policy = await readPlanningPolicy(tx); const active = await readActiveStrategyRef(tx);
    const shift = Date.parse(input.scheduledFor) - Date.parse(item.scheduledFor);
    const candidate = { ...item, scheduledFor: new Date(input.scheduledFor).toISOString(),
      ...(input.measurementChange ? { measurements: [...item.measurements.filter(m => m.definition.id !== input.measurementChange!.measurement.id), pinMeasurement(input.measurementChange.measurement)] } : {}),
      ...(item.publicationWindowEndAt ? { publicationWindowEndAt: new Date(Date.parse(item.publicationWindowEndAt) + shift).toISOString() } : {}),
      ...(item.productionDeadlineAt ? { productionDeadlineAt: new Date(Date.parse(item.productionDeadlineAt) + shift).toISOString() } : {}),
    };
    const calendar = await plannedCalendar(tx, true);
    const reasons = calendarConflicts(candidate, calendar, policy);
    const context = item.productionContext;
    if (context.mode === "source_backed" && (Date.parse(candidate.productionDeadlineAt ?? candidate.scheduledFor) < Date.parse(context.plan.horizonStartAt) || Date.parse(candidate.publicationWindowEndAt ?? candidate.scheduledFor) > Date.parse(context.plan.horizonEndAt))) reasons.push("schedule outside approved planning horizon");
    if (digest(active) !== digest(item.strategyRef)) reasons.push("strategy revision changed");
    if (state.status === "completed") throw new Error("completed work is immutable");
    const authority = await readPlannedExecutionAuthority(tx, item, state);
    const protectedStates = ["running", "awaiting_approval", "requires_disposition", "cancelled"];
    if (authority.claimed || protectedStates.includes(state.status)) reasons.push("claimed or approved work requires exact execution disposition");
    const affected = new Map([[digest(item.ref), item]]);
    // Every unclaimed dependent is revised in the same commit, including transitive dependencies.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const dependent of calendar.filter(candidate => candidate.planRef.id === plan.ref.id)) {
        if (affected.has(digest(dependent.ref)) || !dependent.dependencies.some(ref => affected.has(digest(ref)))) continue;
        affected.set(digest(dependent.ref), dependent); expanded = true;
      }
    }
    const guarded: Array<{ itemRef: AuthorityRef; authorityDigest: string }> = [];
    if (authority.claimed || protectedStates.includes(state.status)) guarded.push({ itemRef: item.ref, authorityDigest: authority.digest });
    for (const dependent of affected.values()) {
      if (dependent.ref.id === item.ref.id) continue;
      const lifecycle = await readItemState(dependent.ref, tx);
      const execution = await readPlannedExecutionAuthority(tx, dependent, lifecycle);
      if (execution.claimed || ["completed", ...protectedStates].includes(lifecycle.status)) {
        reasons.push(`dependent ${dependent.ref.id} requires exact execution disposition`);
        guarded.push({ itemRef: dependent.ref, authorityDigest: execution.digest });
      }
    }
    const now = new Date().toISOString();
    let result: Awaited<ReturnType<typeof replanItem>>;
    if (reasons.length) {
      result = { outcome: "proposal", reasons, proposalId: commandId };
      tx.insert(recordKey(`${campaignRoot()}/planning_proposals/${commandId}`), { workspaceId: item.workspaceId, brandId: item.brandId, type: input.measurementChange ? "measurement_change" : "calendar_change", input, reasons, guarded, state: "pending_approval", at: now, actor: tenantSubjectId(currentTenant()) });
      for (const guard of guarded) {
        const priorState = await readItemState(guard.itemRef, tx);
        tx.put(authorityKey("planned_item_states", guard.itemRef), { ...priorState, dispositionProposalId: commandId, reason: reasons.join("; "), updatedAt: now });
      }
    } else {
      const planRef = scopedRef(plan.ref.id, plan.ref.revision + 1); const ref = scopedRef(item.ref.id, item.ref.revision + 1);
      const replacements = new Map([...affected.values()].map(item => [digest(item.ref), scopedRef(item.ref.id, item.ref.revision + 1)]));
      for (const priorItem of affected.values()) {
        const nextRef = replacements.get(digest(priorItem.ref))!;
        const nextItem = { ...(priorItem.ref.id === item.ref.id ? candidate : priorItem), ref: nextRef, planRef, dependencies: priorItem.dependencies.map(ref => replacements.get(digest(ref)) ?? ref), createdAt: now };
        // Calendar projections contain mutable lifecycle data; immutable definitions do not.
        const { lifecycle: _lifecycle, ...definition } = nextItem as PlannedItem & { lifecycle?: PlannedItemState };
        void _lifecycle;
        assertItemProductionContext(definition);
        tx.insert(authorityKey("planned_item_revisions", nextRef), definition);
        tx.insert(authorityKey("planned_item_states", nextRef), { ref: nextRef, workspaceId: nextRef.workspaceId, brandId: nextRef.brandId, status: "planned", updatedAt: now });
      }
      tx.insert(authorityKey("plan_revisions", planRef), { ...plan, ref: planRef, itemRefs: plan.itemRefs.map(old => replacements.get(digest(old)) ?? old), reason: "Operator calendar change", createdAt: now, createdBy: tenantSubjectId(currentTenant()) });
      tx.put(pointerKey("plans", planRef.id), planRef); result = { outcome: "applied", itemRef: ref, reasons: [] };
    }
    tx.insert(receiptKey, { workspaceId: item.workspaceId, brandId: item.brandId, digest: digest(input), result, at: now, actor: tenantSubjectId(currentTenant()) }); return result;
  });
}
