import { sourceAnalysisDigest } from "../sourceAnalysis";
import { strategySourceEvidenceIds } from "../strategyApproval";
import type { EditorialPlan, EditorialPlanningSnapshot, Job } from "../types";
import { strategySourceBindingSchema, type StrategySourceBinding } from "./contracts";

type SourceJob = Pick<Job, "id" | "strategyRef" | "sourceAnalysis">;

export function buildStrategySourceBinding(job: SourceJob): StrategySourceBinding {
  if (!job.strategyRef || !job.sourceAnalysis) throw new Error("pinned strategy and authoritative job analysis required");
  return strategySourceBindingSchema.parse({ jobId: job.id, strategyRef: job.strategyRef, analysisDigest: sourceAnalysisDigest(job.sourceAnalysis), evidenceIds: strategySourceEvidenceIds(job.sourceAnalysis) });
}

export function assertJobSourceBinding(job: SourceJob, snapshot: EditorialPlanningSnapshot, plan?: EditorialPlan): void {
  const expected = buildStrategySourceBinding(job);
  if (!snapshot.sourceBinding || sourceAnalysisDigest(snapshot.sourceBinding) !== sourceAnalysisDigest(expected)) throw new Error("editorial job source binding mismatch");
  const allowed = new Set(expected.evidenceIds);
  const sourceItems = new Set([...job.sourceAnalysis!.moments, ...job.sourceAnalysis!.angles].map((item) => item.id));
  for (const item of plan?.items ?? []) {
    if (!item.evidenceRefs.length || item.evidenceRefs.some((ref) => !allowed.has(ref)) || !item.evidenceRefs.some((ref) => sourceItems.has(ref))) throw new Error("editorial item evidence is outside authoritative job sources");
  }
}
