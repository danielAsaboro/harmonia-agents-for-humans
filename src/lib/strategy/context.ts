import type { Job } from "../types";
import { awsRepository } from "../dynamo";
import { listCurrentPlans } from "../campaigns/repository";
import { resolvePlannedJob } from "../campaigns/editorial";
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
  return resolvePlannedJob({ ...job, contentStrategy: revision.strategy, strategyDigest: revision.ref.digest,
    strategyApprovalState: "approved", strategyApproval: revision.approval,
    strategyRevision: revision.strategy.version, strategyEvidenceLineage: revision.evidenceLineage,
    strategyInvocationContext: revision.invocationContext }, reader);
}

export async function loadActiveStrategyContext(reader: StrategyReader = awsRepository()) {
  const activeStrategy = await getActiveStrategy(reader);
  if (!activeStrategy) return { activeStrategy: null, plans: [] };
  const plans = (await listCurrentPlans(reader)).filter(plan => strategyDigest(plan.strategyRef) === strategyDigest(activeStrategy.ref)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { activeStrategy, plans };
}
