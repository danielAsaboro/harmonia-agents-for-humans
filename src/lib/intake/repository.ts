import { createHash } from "node:crypto";
import { awsRepository, recordKey, type DynamoTransaction } from "../dynamo";
import { currentTenant, tenantSubjectId, assertResourceWorkspace } from "../tenancy";
import { readActiveStrategyRef, type StrategyReader } from "../strategy/repository";
import { loadActiveStrategyContext } from "../strategy/context";
import { hasRightsAttestation } from "../sourceRights";
import { requireContentOperator } from "../authority";
import { strategyDigest } from "../strategyApproval";
import { evaluateIntake, intakeAdviceSchema, type IntakeAdvice, type IntakeDraft, type IntakeTarget } from "./contracts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const turnDigest = (message: string, attachmentIds: string[]) => hash([message, [...attachmentIds].sort()]);
const root = () => { const t = currentTenant(); return `workspaces/${t.workspaceId}/brands/${t.brandId}`; };
export const intakeDraftKey = (id: string) => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid intake draft id");
  return recordKey(`${root()}/intake_drafts/${id}`);
};
function checkedDraft(value: unknown): IntakeDraft {
  const draft = value as IntakeDraft;
  assertResourceWorkspace(currentTenant(), draft);
  if (draft.subjectId !== tenantSubjectId(currentTenant())) throw new Error("intake operator access denied");
  return draft;
}
export async function readIntakeDraft(id: string, reader = awsRepository()): Promise<IntakeDraft | null> {
  const row = await reader.read(intakeDraftKey(id));
  return row.present ? checkedDraft(row.value) : null;
}
function conversationKey(surface: string, conversationId: string) {
  return recordKey(`${root()}/intake_conversations/${hash([tenantSubjectId(currentTenant()), surface, conversationId])}`);
}
export async function pendingIntakeDraft(surface: string, conversationId: string): Promise<IntakeDraft | null> {
  const row = await awsRepository().read(conversationKey(surface, conversationId));
  return row.present && typeof row.value?.draftId === "string" ? readIntakeDraft(row.value.draftId) : null;
}
export async function replayIntakeTurn(input: { surface: string; conversationId: string; requestId: string; message: string; attachmentIds: string[] }): Promise<IntakeDraft | null> {
  const identity = [tenantSubjectId(currentTenant()), input.surface, input.conversationId, input.requestId];
  const row = await awsRepository().read(recordKey(`${root()}/intake_messages/${hash(identity)}`));
  if (!row.present) return null;
  if (row.value?.messageDigest !== turnDigest(input.message, input.attachmentIds)) throw new Error("intake request identity reused with different input");
  return readIntakeDraft(String(row.value?.draftId));
}
export async function authorizedIntakeTargets(reader?: StrategyReader): Promise<IntakeTarget[]> {
  const { strategyPlan } = await loadActiveStrategyContext(reader);
  return strategyPlan?.items.map(item => ({ campaignId: strategyPlan.planId, itemId: item.id, name: item.campaignTheme })) ?? [];
}
export interface IntakeTurn {
  requestId: string; conversationId: string; surface: "dashboard" | "telegram";
  message: string; advice: IntakeAdvice;
}
export async function submitIntakeTurn(input: IntakeTurn): Promise<IntakeDraft> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.conversationId)) throw new Error("durable intake request identity required");
  const advice = intakeAdviceSchema.parse(input.advice);
  const tenant = currentTenant();
  requireContentOperator(tenant);
  const identity = [tenantSubjectId(tenant), input.surface, input.conversationId, input.requestId];
  const messageKey = recordKey(`${root()}/intake_messages/${hash(identity)}`);
  const pointerKey = conversationKey(input.surface, input.conversationId);
  const messageDigest = turnDigest(input.message, advice.sourceHandles.flatMap(source => source.kind === "upload" ? [source.attachmentId] : []));
  return awsRepository().atomic(async tx => {
    const existing = await tx.read(messageKey);
    if (existing.present) {
      if (existing.value?.messageDigest !== messageDigest) throw new Error("intake request identity reused with different input");
      return checkedDraft((await tx.read(intakeDraftKey(String(existing.value?.draftId)))).value);
    }
    const pointer = await tx.read(pointerKey);
    const priorRow = pointer.present ? await tx.read(intakeDraftKey(String(pointer.value?.draftId))) : null;
    const previous = priorRow?.present ? checkedDraft(priorRow.value) : null;
    const prior = previous?.state === "clarifying" || previous?.state === "ready" ? previous : null;
    const now = new Date().toISOString();
    const sourceHandles = [...new Map([...(prior?.sourceHandles ?? []), ...advice.sourceHandles].map(source => [JSON.stringify(source), source])).values()];
    const merged: IntakeAdvice = { ...advice, sourceHandles,
      expectedOutcome: advice.expectedOutcome || prior?.expectedOutcome || "",
      requestedOutputs: advice.requestedOutputs.length ? advice.requestedOutputs : prior?.requestedOutputs ?? [],
      ...(advice.targetName || prior?.targetName ? { targetName: advice.targetName || prior?.targetName } : {}),
      ...(advice.strategyContext || prior?.strategyContext ? { strategyContext: advice.strategyContext || prior?.strategyContext } : {}),
    };
    if (merged.disposition === "independent" || merged.disposition === "knowledge_only") delete merged.targetName;
    const rightsAttested = Boolean(prior?.rightsAttested || hasRightsAttestation(input.message));
    const assessment = evaluateIntake({ ...merged, rightsAttested }, merged.disposition === "existing_plan_item" ? await authorizedIntakeTargets(tx) : []);
    const active = await readActiveStrategyRef(tx);
    if (merged.action === "revise_strategy" && !active) {
      assessment.missingFields.push("activeStrategy"); assessment.question ??= "There is no approved strategy to revise. Would you like to establish one?";
    }
    if (["establish_strategy", "revise_strategy"].includes(merged.action) && !merged.strategyContext && merged.disposition !== "knowledge_only") {
      assessment.missingFields.push("strategyContext"); assessment.question ??= "What company, audience, positioning and business outcome should the strategy address?";
    }
    const id = prior?.id ?? hash(identity);
    const draft: IntakeDraft = { ...merged, ...assessment, id, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
      subjectId: tenantSubjectId(tenant), conversationId: input.conversationId, operationId: prior?.operationId ?? input.requestId,
      surface: input.surface, originalOperatorBrief: prior?.originalOperatorBrief ?? input.message,
      answers: [...(prior?.answers ?? []), { requestId: input.requestId, message: input.message, at: now }],
      rightsAttested, state: assessment.missingFields.length ? "clarifying" : merged.disposition === "knowledge_only" ? "retained" : !sourceHandles.length && !["establish_strategy", "revise_strategy"].includes(merged.action) ? "ready_for_planning" : "ready",
      revision: (prior?.revision ?? 0) + 1, idempotencyKey: id,
      strategyBaseRef: prior ? prior.strategyBaseRef : active,
      createdAt: prior?.createdAt ?? now, updatedAt: now,
    };
    tx.put(intakeDraftKey(id), draft);
    tx.insert(messageKey, { draftId: id, messageDigest });
    tx.put(pointerKey, { draftId: id });
    return draft;
  });
}

/** Called in the job/outbox transaction, so interrupted or concurrent dispatch cannot duplicate work. */
export async function bindIntakeJob(tx: DynamoTransaction, draft: IntakeDraft, jobId: string) {
  const row = await tx.read(intakeDraftKey(draft.id));
  if (!row.present) throw new Error("intake draft missing");
  const current = checkedDraft(row.value);
  if (current.state !== "ready" || current.revision !== draft.revision || current.disposition === "knowledge_only") throw new Error("intake draft changed before dispatch");
  const active = await readActiveStrategyRef(tx);
  if (current.disposition === "existing_plan_item") {
    const targets = await authorizedIntakeTargets(tx);
    if (!current.target || !targets.some(target => target.campaignId === current.target?.campaignId && target.itemId === current.target?.itemId)) throw new Error("planned intake target is no longer authorized");
  }
  if ((["establish_strategy", "revise_strategy"].includes(current.action) || current.disposition === "existing_plan_item") && strategyDigest(active) !== strategyDigest(current.strategyBaseRef)) throw new Error("active strategy changed; revise the intake against its current revision");
  tx.put(intakeDraftKey(draft.id), { ...current, state: "dispatched", jobId, revision: current.revision + 1, updatedAt: new Date().toISOString() });
}
