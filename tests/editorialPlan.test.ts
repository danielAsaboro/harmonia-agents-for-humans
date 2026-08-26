import { describe, expect, it } from "vitest";
import { assertEditorialPlanSubmission, editorialPlanDigest, editorialPlanEvidenceLineage } from "@/lib/editorialPlan";

const item = {
  id: "item-1", briefId: "brief-1", campaignTheme: "Proof", contentPillar: "Operations",
  objective: "Show proof", audienceId: "founders", funnelStage: "consideration" as const,
  intendedConversion: "request demo", ctaIntent: "request demo", kpi: "qualified demos",
  channel: "x", format: "text_post", evidenceRefs: ["m1", "context:campaign"],
  publicationWindowStartAt: "2026-09-01T16:00:00Z", publicationWindowEndAt: "2026-09-01T18:00:00Z",
  productionDeadlineAt: "2026-08-31T18:00:00Z", priority: 1, selectionScore: 0.9,
  dependencies: [], productionStatus: "planned" as const, constraints: [], requiredAssets: [],
  planningRationale: "Lead with proof.", selectionRationale: "Highest priority eligible item.", confidence: "high" as const,
};

const plan = {
  planId: "plan-job-1-v1", version: 1, approvedStrategyDigest: "a".repeat(64),
  horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "UTC",
  summary: "Proof campaign.", sequencingRationale: "Proof first.", cadenceRationale: "One item.",
  assumptions: [], confidence: "high" as const, items: [item], selectedNextItemId: "item-1",
};

const job = {
  stage: "plan", strategyDigest: "a".repeat(64), strategyRevision: 1,
  contentStrategy: { strategyId: "strategy-job-1-v1", version: 1 },
  strategyApprovalState: "approved", strategyApproval: { decision: "approved", payloadDigest: "a".repeat(64), revision: 1 },
  editorialPlanHistory: undefined,
};

describe("editorial plan persistence boundary", () => {
  it("digests canonical plan JSON independent of object key order", () => {
    expect(editorialPlanDigest({ b: 2, a: 1 })).toBe(editorialPlanDigest({ a: 1, b: 2 }));
    expect(editorialPlanDigest(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds a fresh plan to the exact approved strategy and revision", () => {
    expect(() => assertEditorialPlanSubmission(job, plan, 1)).not.toThrow();
    expect(() => assertEditorialPlanSubmission(job, { ...plan, approvedStrategyDigest: "b".repeat(64) }, 1)).toThrow("strategy digest");
    expect(() => assertEditorialPlanSubmission(job, plan, 2)).toThrow("stale editorial plan revision");
    expect(() => assertEditorialPlanSubmission({ ...job, stage: "draft" }, plan, 1)).toThrow("job stage");
    expect(() => assertEditorialPlanSubmission({ ...job, contentStrategy: undefined }, plan, 1)).toThrow("persisted strategy identity");
  });

  it("rejects replay and requires an eligible planned selected item", () => {
    const history = { v1: { digest: editorialPlanDigest(plan) } };
    expect(() => assertEditorialPlanSubmission({ ...job, editorialPlanHistory: history }, plan, 1)).toThrow("already exists");
    expect(() => assertEditorialPlanSubmission(job, { ...plan, items: [{ ...item, productionStatus: "selected" as never }] }, 1)).toThrow("selected item");
  });

  it("records sorted unique evidence lineage", () => {
    expect(editorialPlanEvidenceLineage(plan)).toEqual(["context:campaign", "m1"]);
  });
});
