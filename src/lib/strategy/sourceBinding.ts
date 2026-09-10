import { sourceAnalysisDigest } from "../sourceAnalysis";
import { strategySourceEvidenceIds } from "../strategyApproval";
import type { EditorialPlan, EditorialPlanningSnapshot, Job } from "../types";
import { strategySourceBindingSchema, operatorSourceBindingSchema, type PlanningSourceBinding, type StrategySourceBinding } from "./contracts";

type SourceJob = Pick<Job, "id" | "strategyRef" | "sourceAnalysis" | "operatorPlanningContext">;

export function buildStrategySourceBinding(job: SourceJob & { sourceAnalysis: NonNullable<Job["sourceAnalysis"]> }): StrategySourceBinding;
export function buildStrategySourceBinding(job: SourceJob): PlanningSourceBinding;
export function buildStrategySourceBinding(job: SourceJob): PlanningSourceBinding {
  if (!job.sourceAnalysis && job.operatorPlanningContext?.mode === "operator_context") {
    const context = job.operatorPlanningContext;
    if (context.contextDigest !== sourceAnalysisDigest(context.operatorBrief)) throw new Error("operator context digest mismatch");
    return operatorSourceBindingSchema.parse({ ...context, jobId: job.id, strategyRef: job.strategyRef });
  }
  if (!job.strategyRef || !job.sourceAnalysis) throw new Error("pinned strategy and authoritative job analysis required");
  return strategySourceBindingSchema.parse({ jobId: job.id, strategyRef: job.strategyRef, analysisDigest: sourceAnalysisDigest(job.sourceAnalysis), evidenceIds: strategySourceEvidenceIds(job.sourceAnalysis) });
}

export function assertJobSourceBinding(job: SourceJob, snapshot: EditorialPlanningSnapshot, plan?: EditorialPlan): void {
  const expected = buildStrategySourceBinding(job);
  if (!snapshot.sourceBinding || sourceAnalysisDigest(snapshot.sourceBinding) !== sourceAnalysisDigest(expected)) throw new Error("editorial job source binding mismatch");
  const allowed = new Set(expected.evidenceIds);
  if ("mode" in expected) {
    if (plan?.items.some(item => item.evidenceRefs.length)) throw new Error("operator context cannot invent factual evidence");
    return;
  }
  const sourceItems = new Set([...job.sourceAnalysis!.moments, ...job.sourceAnalysis!.angles].map((item) => item.id));
  for (const item of plan?.items ?? []) {
    if (!item.evidenceRefs.length || item.evidenceRefs.some((ref) => !allowed.has(ref)) || !item.evidenceRefs.some((ref) => sourceItems.has(ref))) throw new Error("editorial item evidence is outside authoritative job sources");
  }
}
