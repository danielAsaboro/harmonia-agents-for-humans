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

  it("matches the cross-runtime JSON-number fixture without erasing fractional scores", () => {
    const boundary = {
      planId: "p", version: 1, approvedStrategyDigest: "a".repeat(64),
      horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "UTC",
      summary: "s", sequencingRationale: "s", cadenceRationale: "c", assumptions: [], confidence: "high",
      items: [{
        id: "i", briefId: "b", campaignTheme: "t", contentPillar: "p", objective: "o", audienceId: "a",
        funnelStage: "awareness", intendedConversion: "c", ctaIntent: "c", kpi: "k", channel: "x", format: "text",
        evidenceRefs: ["m1"], publicationWindowStartAt: "2026-09-01T00:00:00Z", publicationWindowEndAt: "2026-09-01T01:00:00Z",
        productionDeadlineAt: "2026-08-31T12:00:00Z", priority: 1, selectionScore: 0, dependencies: [], productionStatus: "planned",
        constraints: [], requiredAssets: [], planningRationale: "r", selectionRationale: "r", confidence: "high",
      }], selectedNextItemId: "i",
    };
    expect(editorialPlanDigest(boundary)).toBe("cffb8018ff7a322277d5461d6b77b46ef923371a97c977a7549b74706a10bea1");
    const fractional = structuredClone(boundary);
    fractional.items[0].selectionScore = 0.5;
    expect(editorialPlanDigest(fractional)).not.toBe(editorialPlanDigest(boundary));
    expect(editorialPlanDigest({ score: -0, priority: 1.0 })).toBe(editorialPlanDigest({ score: 0, priority: 1 }));
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
