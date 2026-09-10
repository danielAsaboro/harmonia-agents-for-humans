import { describe, expect, it } from "vitest";
import { buildStrategySourceBinding, assertJobSourceBinding } from "@/lib/strategy/sourceBinding";
import { sourceAnalysisDigest as strategyDigest } from "@/lib/sourceAnalysis";
import type { Job, EditorialPlanningSnapshot, EditorialPlan } from "@/lib/types";

describe("host no-source planning contract", () => {
  const brief = "Invent a playful invitation for founders to imagine a better workflow";
  const job = { id: "planned-1", strategyRef: { workspaceId: "w", brandId: "b", strategyId: "direction", revision: 1, digest: "a".repeat(64) }, operatorPlanningContext: { mode: "operator_context", operatorBrief: brief, contextDigest: strategyDigest(brief), evidenceIds: [], factualClaimsAllowed: false } } as unknown as Job;
  it("keeps operator instructions separate from factual evidence", () => {
    const binding = buildStrategySourceBinding(job);
    expect(binding).toMatchObject({ mode: "operator_context", jobId: job.id, evidenceIds: [], factualClaimsAllowed: false });
    expect(binding).not.toHaveProperty("analysisDigest");
    const snapshot = { sourceBinding: binding } as EditorialPlanningSnapshot;
    expect(() => assertJobSourceBinding(job, snapshot, { items: [{ evidenceRefs: ["invented:fact"] }] } as EditorialPlan)).toThrow("evidence");
    expect(() => assertJobSourceBinding(job, snapshot, { items: [{ evidenceRefs: [] }] } as unknown as EditorialPlan)).not.toThrow();
  });
  it("refuses changed operator context digests", () => {
    expect(() => buildStrategySourceBinding({ ...job, operatorPlanningContext: { ...job.operatorPlanningContext!, operatorBrief: "Changed" } } as Job)).toThrow("context digest");
  });
});
