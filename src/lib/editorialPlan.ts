import { createHash } from "node:crypto";
import type { EditorialPlan } from "./types";

function canonicalBytes(value: unknown): string {
  if (value === null) return "n;";
  if (typeof value === "boolean") return value ? "b1;" : "b0;";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("editorial plan digest requires finite numbers");
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value);
    return `d${bytes.toString("hex")};`;
  }
  if (typeof value === "string") return `s${Buffer.byteLength(value, "utf8")}:${value}`;
  if (Array.isArray(value)) return `a${value.length}[${value.map(canonicalBytes).join("")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `o${entries.length}{${entries.map(([key, entry]) => canonicalBytes(key) + canonicalBytes(entry)).join("")}}`;
  }
  throw new Error("editorial plan digest contains an unsupported value");
}

export function editorialPlanDigest(plan: unknown): string {
  return createHash("sha256").update(canonicalBytes(plan), "utf8").digest("hex");
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
