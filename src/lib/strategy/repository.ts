import { contentStrategySchema } from "../contracts";
import { awsRepository, partition, type DynamoTransaction, type RecordKey, type StoredRecord, recordKey } from "../dynamo";
import { applyStrategyDecision, strategyDigest, type StrategyDecisionInput } from "../strategyApproval";
import { assertResourceWorkspace, currentTenant, tenantSubjectId } from "../tenancy";
import { strategyRefSchema, type ApprovedStrategyRevision, type StrategyProposal, type StrategyRef } from "./contracts";

// Brand is part of the key as well as the checked value. No workspace-wide singleton.
const root = () => { const tenant = currentTenant(); return `workspaces/${tenant.workspaceId}/brands/${tenant.brandId}`; };
const pointerKey = () => recordKey(`${root()}/strategy_authority/active`);
const revisionKey = (revision: number) => recordKey(`${root()}/strategy_revisions/${revision}`);
const proposalKey = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw new Error("invalid strategy proposal id");
  return recordKey(`${root()}/strategy_proposals/${id}`);
};
export type StrategyReader = { read(key: RecordKey): Promise<StoredRecord> };

export async function readActiveStrategyRef(reader: StrategyReader = awsRepository()): Promise<StrategyRef | null> {
  const row = await reader.read(pointerKey());
  if (!row.present) return null;
  const ref = strategyRefSchema.parse(row.value);
  assertResourceWorkspace(currentTenant(), ref);
  return ref;
}

export async function readStrategyRevision(ref: StrategyRef, reader: StrategyReader = awsRepository()): Promise<ApprovedStrategyRevision> {
  strategyRefSchema.parse(ref);
  assertResourceWorkspace(currentTenant(), ref);
  const row = await reader.read(revisionKey(ref.revision));
  if (!row.present) throw new Error("approved strategy revision not found");
  const record = row.value as unknown as ApprovedStrategyRevision;
  assertResourceWorkspace(currentTenant(), record);
  const storedRef = strategyRefSchema.parse(record.ref);
  assertResourceWorkspace(currentTenant(), storedRef);
  if (strategyDigest(storedRef) !== strategyDigest(ref) || record.strategy.strategyId !== ref.strategyId || strategyDigest(record.strategy) !== ref.digest || record.approval?.decision !== "approved" || record.approval.payloadDigest !== ref.digest || record.approval.revision !== record.strategy.version) throw new Error("immutable strategy reference mismatch");
  contentStrategySchema.parse(record.strategy);
  if (record.invocationContext.learningEvidence?.length) {
    const { validateStrategyLearningGrounding } = await import("../learning/proposals");
    await validateStrategyLearningGrounding(record.strategy, record.invocationContext, reader);
  }
  return record;
}

export async function getActiveStrategy(reader: StrategyReader = awsRepository()): Promise<ApprovedStrategyRevision | null> {
  const ref = await readActiveStrategyRef(reader);
  return ref ? readStrategyRevision(ref, reader) : null;
}

export async function insertStrategyProposal(tx: DynamoTransaction, input: Omit<StrategyProposal, "id" | "workspaceId" | "brandId" | "expectedActiveRevision" | "baseStrategyRef" | "approval" | "strategyRef">, expectedBase?: StrategyRef | null): Promise<StrategyProposal> {
  const { validateStrategyLearningGrounding } = await import("../learning/proposals");
  const strategy = contentStrategySchema.parse(input.strategy);
  if (strategyDigest(strategy) !== input.digest) throw new Error("strategy payload changed");
  if (![1, 2].includes(input.attempt) || strategy.version !== input.attempt) throw new Error("invalid strategy proposal attempt");
  const active = await readActiveStrategyRef(tx);
  if (expectedBase !== undefined && strategyDigest(expectedBase) !== strategyDigest(active)) throw new Error("strategy base changed before proposal");
  await validateStrategyLearningGrounding(strategy, input.invocationContext, tx);
  const tenant = currentTenant();
  const proposal: StrategyProposal = { ...input, strategy, id: `${input.jobId}-${input.attempt}`, workspaceId: tenant.workspaceId, brandId: tenant.brandId, expectedActiveRevision: active?.revision ?? 0, baseStrategyRef: active };
  tx.insert(proposalKey(proposal.id), proposal);
  return proposal;
}

export async function readStrategyProposal(id: string, reader: StrategyReader = awsRepository()): Promise<StrategyProposal> {
  const row = await reader.read(proposalKey(id));
  if (!row.present) throw new Error("strategy proposal not found");
  const proposal = row.value as unknown as StrategyProposal;
  assertResourceWorkspace(currentTenant(), proposal);
  if (proposal.id !== id || strategyDigest(proposal.strategy) !== proposal.digest) throw new Error("strategy proposal binding mismatch");
  return proposal;
}

/** Complete durable proposal read for current-operation projections. */
export async function listStrategyProposals(): Promise<StrategyProposal[]> {
  const rows = await awsRepository().query(partition(`${root()}/strategy_proposals`));
  return Promise.all(rows.rows.map(row => readStrategyProposal(row.id)));
}

export async function decideStrategyProposal(tx: DynamoTransaction, id: string, input: StrategyDecisionInput) {
  const proposal = await readStrategyProposal(id, tx);
  const { validateStrategyLearningGrounding } = await import("../learning/proposals");
  await validateStrategyLearningGrounding(proposal.strategy, proposal.invocationContext, tx);
  if (input.expectedActiveRevision !== proposal.expectedActiveRevision) throw new Error("strategy expected active revision mismatch");
  if (strategyDigest(proposal.strategy) !== proposal.digest || input.payloadDigest !== proposal.digest) throw new Error("strategy payload changed");
  const actorSubjectId = tenantSubjectId(currentTenant());
  if (proposal.approval) {
    const prior = proposal.approval;
    if (prior.decision !== input.decision || prior.actorSubjectId !== actorSubjectId || (prior.feedback ?? "") !== (input.feedback?.trim() ?? "")) throw new Error("strategy decision already recorded");
    return { ...applyStrategyDecision({ revision: proposal.attempt, strategyDigest: proposal.digest, approvalExpiresAt: proposal.expiresAt }, input, actorSubjectId, new Date(prior.decidedAt)), approval: prior, strategyRef: proposal.strategyRef, replayed: true };
  }
  const result = applyStrategyDecision({ revision: proposal.attempt, strategyDigest: proposal.digest, approvalExpiresAt: proposal.expiresAt }, input, actorSubjectId, new Date());
  let strategyRef: StrategyRef | undefined;
  if (result.approval.decision === "approved") {
    const active = await readActiveStrategyRef(tx);
    if ((active?.revision ?? 0) !== input.expectedActiveRevision) throw new Error("stale active strategy revision");
    if (strategyDigest(active) !== strategyDigest(proposal.baseStrategyRef)) throw new Error("strategy base changed before approval");
    strategyRef = strategyRefSchema.parse({ workspaceId: proposal.workspaceId, brandId: proposal.brandId, strategyId: proposal.strategy.strategyId, revision: proposal.expectedActiveRevision + 1, digest: proposal.digest });
    const revision: ApprovedStrategyRevision = { workspaceId: proposal.workspaceId, brandId: proposal.brandId, ref: strategyRef, proposalId: proposal.id, jobId: proposal.jobId, strategy: proposal.strategy, approval: { ...result.approval, decision: "approved" }, evidenceLineage: proposal.evidenceLineage, invocationContext: proposal.invocationContext };
    tx.insert(revisionKey(strategyRef.revision), revision);
    tx.put(pointerKey(), strategyRef);
    const { proposeQueuedStrategyDispositions } = await import("../planning/dispositions");
    await proposeQueuedStrategyDispositions(tx, strategyRef);
  }
  tx.patch(proposalKey(id), { approval: result.approval, ...(strategyRef ? { strategyRef } : {}) });
  return { ...result, strategyRef, replayed: false };
}
