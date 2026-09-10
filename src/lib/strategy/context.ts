import type { Job } from "../types";
import { awsRepository, recordKey } from "../dynamo";
import { editorialPlanDigest } from "../editorialPlan";
import { assertResourceWorkspace, currentTenant } from "../tenancy";
import { strategyDigest } from "../strategyApproval";
import { getActiveStrategy, readStrategyProposal, readStrategyRevision, type StrategyReader } from "./repository";

/** Job-local proposal fields are drafts. Approved views always reread the pinned immutable record. */
export async function resolveJobStrategy<T extends Job>(job: T, reader?: StrategyReader): Promise<T> {
  if (!job.strategyRef) {
    if (!job.strategyProposalId) return job;
    const proposal = await readStrategyProposal(job.strategyProposalId, reader);
    if (proposal.jobId !== job.id) throw new Error("strategy proposal job mismatch");
    return { ...job, contentStrategy: proposal.strategy, strategyDigest: proposal.digest,
      strategyExpectedActiveRevision: proposal.expectedActiveRevision,
      strategyApprovalState: proposal.approval?.decision ?? "pending", strategyApproval: proposal.approval,
      strategyApprovalExpiresAt: proposal.expiresAt, strategyEvidenceLineage: proposal.evidenceLineage,
      strategyInvocationContext: proposal.invocationContext };
  }
  const revision = await readStrategyRevision(job.strategyRef, reader);
  return { ...job, contentStrategy: revision.strategy, strategyDigest: revision.ref.digest,
    strategyApprovalState: "approved", strategyApproval: revision.approval,
    strategyRevision: revision.strategy.version, strategyEvidenceLineage: revision.evidenceLineage,
    strategyInvocationContext: revision.invocationContext };
}

export async function loadActiveStrategyContext() {
  const activeStrategy = await getActiveStrategy();
  if (!activeStrategy) return { activeStrategy: null, strategyPlan: null };
  const row = await awsRepository().read(recordKey(`workspaces/${currentTenant().workspaceId}/jobs/${activeStrategy.jobId}`));
  if (!row.present) return { activeStrategy, strategyPlan: null };
  const origin = row.value as unknown as Job;
  assertResourceWorkspace(currentTenant(), origin);
  const plan = origin.editorialPlan;
  const bound = origin.strategyRef && strategyDigest(origin.strategyRef) === strategyDigest(activeStrategy.ref)
    && plan?.approvedStrategyDigest === activeStrategy.ref.digest
    && origin.editorialPlanDigest === editorialPlanDigest(plan);
  return { activeStrategy, strategyPlan: bound ? plan : null };
}
