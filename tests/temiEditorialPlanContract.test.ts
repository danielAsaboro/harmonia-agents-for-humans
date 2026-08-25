import { describe, expect, it } from "vitest";
import {
  editorialPlanSchema,
  editorialPlannerInputSchema,
  productionDraftInputSchema,
} from "@/lib/contracts";

const strategy = {
  strategyId: "strategy-job-1-v1", version: 1, horizonWeeks: 4,
  thesis: "Lead with verified operating proof.", differentiatedNarrative: "Harmonia connects evidence to governed execution.",
  objectives: [{ text: "Increase qualified demos", evidenceRefs: ["ctx-campaign"] }],
  audiencePriorities: [{ audienceId: "aud-founders", priority: 1, reason: "Founders own the bottleneck", evidenceRefs: ["ctx-campaign"] }],
  funnelIntent: "consideration", intendedConversions: ["request a product demo"],
  pillars: [{ name: "operational proof", purpose: "Demonstrate measurable gains", evidenceRefs: ["m1", "perf-1"] }],
  campaignThemes: [{ name: "From delay to flow", message: "Governance can accelerate delivery", evidenceRefs: ["m1"] }],
  channelRoles: [{ channel: "x", role: "proof-led discovery", operationallySupported: true, formats: ["text_post"], cadence: "2 posts per week", evidenceRefs: ["ctx-campaign"] }],
  contentMix: [{ format: "text_post", percentage: 100 }], cadenceGuidance: "Two supported-channel items per week.",
  priorityRules: ["Prefer quantified source proof"], ctaGuidance: ["Invite qualified operators to request a demo"],
  kpis: [{ name: "qualified demo requests", target: "measure weekly", measurement: "verified attributed requests", evidenceRefs: ["ctx-campaign"] }],
  successCriteria: ["At least one verified qualified demo request"], constraints: ["Use only supplied evidence"],
  exclusions: ["Unsupported outcome claims"], brandSafety: ["Never imply autonomous approval"],
  briefs: [{ id: "brief-1", title: "Nine days to forty hours", objective: "Show operational proof", audienceId: "aud-founders", funnelStage: "consideration", keyMessage: "Governed workflows reduce activation delay", channelCandidates: ["x"], formatCandidates: ["text_post"], ctaIntent: "request a demo", intendedConversion: "qualified demo request", kpi: "qualified demo requests", priority: 1, dependencies: [], constraints: ["Quote the source exactly"], evidenceRefs: ["m1", "ctx-campaign"] }],
  assumptions: [], confidence: "high",
};

const analysis = {
  summary: "Activation time fell from nine days to forty hours.",
  moments: [{ id: "m1", title: "Activation", startSec: 2, endSec: 8, hook: "Nine days to forty hours", quote: "we cut nine days to forty hours" }],
  angles: [{ id: "a1", kind: "trend", title: "Operational speed", rationale: "The source demonstrates measurable improvement." }],
};

const item = {
  id: "item-1", briefId: "brief-1", campaignTheme: "From delay to flow", contentPillar: "operational proof",
  objective: "Show operational proof", audienceId: "aud-founders", funnelStage: "consideration",
  intendedConversion: "qualified demo request", ctaIntent: "request a demo", kpi: "qualified demo requests",
  channel: "x", format: "text_post", evidenceRefs: ["m1", "ctx-campaign"],
  publicationWindowStartAt: "2026-09-01T16:00:00Z", publicationWindowEndAt: "2026-09-01T18:00:00Z",
  productionDeadlineAt: "2026-08-31T18:00:00Z", priority: 1, selectionScore: 0.9,
  dependencies: [], productionStatus: "planned", constraints: ["Quote the source exactly"], requiredAssets: ["source-clip"],
  planningRationale: "The first proof post opens the campaign.", selectionRationale: "This is the highest-priority unblocked brief.", confidence: "high",
};

const plan = {
  planId: "plan-job-1-v1", version: 1, approvedStrategyDigest: "a".repeat(64),
  horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "America/Los_Angeles",
  summary: "A four-week proof-led campaign.", sequencingRationale: "Start with the strongest source proof.",
  cadenceRationale: "One focused item begins the approved horizon.", assumptions: ["The verified audience remains available during the horizon."],
  confidence: "high", items: [item], selectedNextItemId: "item-1",
};

const plannerInput = {
  strategy, strategyDigest: "a".repeat(64), strategyVersion: 1,
  strategyApproval: { decision: "approved", payloadDigest: "a".repeat(64), revision: 1, actorSubjectId: "operator-1", decidedAt: "2026-08-30T00:00:00Z", expiresAt: "2026-08-31T00:00:00Z" },
  analysis, horizonStartAt: "2026-08-31T00:00:00Z", horizonEndAt: "2026-09-28T00:00:00Z", timezone: "America/Los_Angeles",
  channelCapabilities: [{ channel: "x", formats: ["text_post"] }],
  existingCommitments: [{ id: "commitment-1", channel: "x", publicationWindowStartAt: "2026-09-03T16:00:00Z", publicationWindowEndAt: "2026-09-03T18:00:00Z" }],
  productionCapacity: { maxItems: 8, maxItemsPerWeek: 2 }, cadenceConstraints: { minimumHoursBetweenItems: 24, maxItemsPerChannelPerWeek: 2 },
  postingWindowObservations: [{ id: "window-1", channel: "x", format: "text_post", observedAt: "2026-08-29T00:00:00Z", evidenceRefs: ["perf-1"] }], revision: 1,
};

const productionInput = {
  planId: "plan-job-1-v1", strategyDigest: "a".repeat(64), editorialItem: item, brief: strategy.briefs[0],
  referencedMoments: analysis.moments, referencedAngles: [], brandContext: "Use a direct, evidence-led voice.",
  constraints: ["Quote the source exactly", "Never imply autonomous approval"],
};

describe("Temi editorial-plan contract parity", () => {
  it("accepts the complete strict Python boundary fixture", () => {
    expect(editorialPlannerInputSchema.parse(plannerInput).timezone).toBe("America/Los_Angeles");
    expect(editorialPlanSchema.parse(plan).selectedNextItemId).toBe("item-1");
    expect(productionDraftInputSchema.parse(productionInput).editorialItem.id).toBe("item-1");
  });

  it("requires complete fields and exactly one selected planned item", () => {
    const incomplete = structuredClone(plan) as Partial<typeof plan>;
    delete incomplete.sequencingRationale;
    expect(editorialPlanSchema.safeParse(incomplete).success).toBe(false);

    const missingSelection = structuredClone(plan);
    missingSelection.selectedNextItemId = "missing-item";
    expect(editorialPlanSchema.safeParse(missingSelection).success).toBe(false);

    const selected = structuredClone(plan);
    selected.items[0].productionStatus = "selected";
    expect(editorialPlanSchema.safeParse(selected).success).toBe(false);
  });

  it("rejects authority overreach and invalid horizon or timezone parity boundaries", () => {
    const overreach = structuredClone(plan) as typeof plan & { finalPostCopy?: string; externalEventId?: string };
    overreach.finalPostCopy = "Buy now";
    overreach.externalEventId = "event-1";
    expect(editorialPlanSchema.safeParse(overreach).success).toBe(false);

    const nonUtc = structuredClone(plannerInput);
    nonUtc.horizonStartAt = "2026-08-31T00:00:00+01:00";
    expect(editorialPlannerInputSchema.safeParse(nonUtc).success).toBe(false);

    const badTimezone = structuredClone(plan);
    badTimezone.timezone = "not/a-timezone";
    expect(editorialPlanSchema.safeParse(badTimezone).success).toBe(false);

    const effect = structuredClone(productionInput) as typeof productionInput & { publishPayload?: unknown };
    effect.publishPayload = { type: "publish_x_post" };
    expect(productionDraftInputSchema.safeParse(effect).success).toBe(false);
  });
});
