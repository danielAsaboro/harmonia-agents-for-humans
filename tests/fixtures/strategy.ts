import type { ContentStrategy } from "@/lib/types";

export const strategyFixture = (id: string, version = 1): ContentStrategy => ({
  strategyId: id, version, horizonWeeks: 4, thesis: `Approved ${id}`, differentiatedNarrative: "Source-backed proof",
  objectives: [{ text: "Educate", evidenceRefs: ["context:campaign"] }],
  audiencePriorities: [{ audienceId: "founders", priority: 1, reason: "Operators", evidenceRefs: ["context:campaign"] }],
  funnelIntent: "consideration", intendedConversions: ["demo"],
  pillars: [{ name: "proof", purpose: "educate", evidenceRefs: ["m1"] }],
  campaignThemes: [{ name: "proof", message: "verify", evidenceRefs: ["m1"] }],
  channelRoles: [{ channel: "x", role: "discovery", operationallySupported: true, formats: ["text_post"], cadence: "weekly", evidenceRefs: ["context:campaign"] }],
  contentMix: [{ format: "text_post", percentage: 100 }], cadenceGuidance: "weekly", priorityRules: ["proof"], ctaGuidance: ["demo"],
  kpis: [{ name: "demos", target: "weekly", measurement: "receipts", evidenceRefs: ["context:campaign"] }],
  successCriteria: ["qualified demo"], constraints: [], exclusions: [], brandSafety: [],
  briefs: [{ id: "brief-1", title: "Proof", objective: "Educate", audienceId: "founders", funnelStage: "consideration", keyMessage: "Verify", channelCandidates: ["x"], formatCandidates: ["text_post"], ctaIntent: "demo", intendedConversion: "demo", kpi: "demos", priority: 1, dependencies: [], constraints: [], evidenceRefs: ["m1"] }],
  assumptions: [], confidence: "high",
});
