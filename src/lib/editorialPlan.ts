import { createHash } from "node:crypto";
import type { EditorialPlan } from "./types";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("editorial plan digest requires finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function editorialPlanDigest(plan: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(plan)), "utf8").digest("hex");
}

export function editorialPlanEvidenceLineage(plan: EditorialPlan): string[] {
  return [...new Set(plan.items.flatMap((item) => item.evidenceRefs))].sort();
}

export function assertEditorialPlanSubmission(
  job: {
    stage: string;
    strategyDigest?: string;
    strategyRevision?: number;
    contentStrategy?: { strategyId: string; version: number };
    strategyApprovalState?: string;
    strategyApproval?: { decision: string; payloadDigest: string; revision: number };
    editorialPlanRevision?: number;
    editorialPlanHistory?: Record<string, unknown>;
  },
  plan: EditorialPlan,
  revision: number,
): void {
  if (job.stage !== "plan") throw new Error(`job stage is '${job.stage}'`);
  const expectedRevision = job.editorialPlanRevision ?? 1;
  if (revision !== expectedRevision || plan.version !== revision) throw new Error("stale editorial plan revision");
  if (!job.contentStrategy?.strategyId || job.contentStrategy.version !== job.strategyRevision) throw new Error("persisted strategy identity required");
  if (!job.strategyDigest || plan.approvedStrategyDigest !== job.strategyDigest) throw new Error("editorial plan strategy digest mismatch");
  const approval = job.strategyApproval;
  if (job.strategyApprovalState !== "approved" || approval?.decision !== "approved") throw new Error("approved strategy required for editorial planning");
  if (approval.payloadDigest !== job.strategyDigest || approval.revision !== job.strategyRevision) throw new Error("editorial plan strategy approval binding mismatch");
  if (job.editorialPlanHistory?.[`v${revision}`]) throw new Error(`editorial plan history v${revision} already exists`);
  const selected = plan.items.filter((item) => item.id === plan.selectedNextItemId);
  if (selected.length !== 1 || selected[0].productionStatus !== "planned" || selected[0].dependencies.length > 0) {
    throw new Error("selected item is not eligible for production");
  }
}
