import { describe, expect, it } from "vitest";
import { contentStrategySchema } from "@/lib/contracts";
import { validatePersistedStrategy, validateStrategySearchGrounding } from "@/lib/strategyApproval";

const refs = ["m1"];
const valid = {
  strategyId: "strategy-job-1-v1", version: 1, horizonWeeks: 4,
  thesis: "Lead with verified proof", differentiatedNarrative: "Evidence connects to governed execution",
  objectives: [{ text: "Increase qualified demos", evidenceRefs: ["context:campaign"] }],
  audiencePriorities: [{ audienceId: "aud-founders", priority: 1, reason: "They own the bottleneck", evidenceRefs: ["context:campaign"] }],
  funnelIntent: "consideration", intendedConversions: ["request a demo"],
  pillars: [{ name: "operational proof", purpose: "Show measurable gains", evidenceRefs: refs }],
  campaignThemes: [{ name: "Delay to flow", message: "Governance accelerates delivery", evidenceRefs: refs }],
  channelRoles: [{ channel: "x", role: "discovery", operationallySupported: true, formats: ["text_post"], cadence: "twice weekly", evidenceRefs: ["context:campaign"] }],
  contentMix: [{ format: "text_post", percentage: 100 }], cadenceGuidance: "Two items weekly",
  priorityRules: ["Prefer proof"], ctaGuidance: ["Invite a demo request"],
  kpis: [{ name: "demo requests", target: "measure weekly", measurement: "verified attribution", evidenceRefs: ["context:campaign"] }],
  successCriteria: ["One verified request"], constraints: ["Use supplied evidence"], exclusions: [], brandSafety: [],
  briefs: [{ id: "brief-1", title: "Nine days to forty hours", objective: "Show proof", audienceId: "aud-founders", funnelStage: "consideration", keyMessage: "Governed workflows reduce delay", channelCandidates: ["x"], formatCandidates: ["text_post"], ctaIntent: "request demo", intendedConversion: "qualified request", kpi: "demo requests", priority: 1, dependencies: [], constraints: ["Quote exactly"], evidenceRefs: refs }],
  assumptions: [], confidence: "high",
};

describe("Ryan strategy wire contract", () => {
  it("accepts the same complete strict shape persisted by Python", () => {
    expect(contentStrategySchema.parse(valid).briefs[0].id).toBe("brief-1");
  });

  it("fails closed on incomplete briefs, final copy, and invalid mix", () => {
    type Mutable = Omit<typeof valid, "briefs"> & { briefs: Array<Partial<(typeof valid.briefs)[number]> & { finalPostCopy?: string }> };
    const incomplete = structuredClone(valid) as Mutable;
    delete incomplete.briefs[0].ctaIntent;
    expect(contentStrategySchema.safeParse(incomplete).success).toBe(false);
    const copy = structuredClone(valid) as Mutable;
    copy.briefs[0].finalPostCopy = "Buy now";
    expect(contentStrategySchema.safeParse(copy).success).toBe(false);
    const mix = structuredClone(valid);
    mix.contentMix[0].percentage = 90;
    expect(contentStrategySchema.safeParse(mix).success).toBe(false);
  });

  it("revalidates provenance and channels against persisted job truth", () => {
    const strategy = contentStrategySchema.parse(valid);
    const job = { config: { platforms: ["x"], strategyContext: {
      company: "Harmonia", product: "content engine", positioning: "governed",
      differentiators: ["evidence"], brandVoice: ["direct"], exclusions: [], safetyConstraints: [],
      businessObjectives: ["demos"], campaignObjectives: ["educate"],
      audiences: [{ id: "aud-founders", name: "Founders", pains: ["bottlenecks"] }],
      funnelStage: "consideration" as const, intendedConversion: "request demo",
      requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4,
    } }, sourceAnalysis: { sourceDigest: "a".repeat(64), summary: "Grounded proof", assumptions: [], confidence: "high",
      moments: [{ id: "m1", title: "Proof", startSec: 0, endSec: 1, hook: "Proof", quote: "Proof",
        transcriptSegmentRefs: ["segment-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" }], angles: [] }, strategyInvocationContext: {
      revision: 1, sourceIds: ["m1"], operatorContextIds: ["context:company", "context:campaign"],
      performance: [], memoryFacts: [], audienceIds: ["aud-founders"],
      requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4,
      researchRequest: null, searchEvidence: [],
    } };
    expect(() => validatePersistedStrategy(job as never, strategy)).not.toThrow();
    const forged = structuredClone(strategy);
    forged.briefs[0].evidenceRefs = ["invented"];
    expect(() => validatePersistedStrategy(job as never, forged)).toThrow("unknown persisted evidence");
    const inventedMemory = structuredClone(strategy);
    inventedMemory.assumptions = [{ text: "invented", evidenceRefs: ["memory:invented"], confidence: "low" }];
    expect(() => validatePersistedStrategy(job as never, inventedMemory)).toThrow("unknown persisted evidence");
    const wrongChannel = structuredClone(strategy);
    wrongChannel.briefs[0].channelCandidates = ["linkedin"];
    expect(() => validatePersistedStrategy(job as never, wrongChannel)).toThrow("unrequested channel");
  });

  it("requires request-bound native grounding for strategy search evidence", () => {
    const request = { id: "research-current-market", question: "What current public evidence describes governed content operations?", justification: "Current external information is necessary." };
    const evidence = [{ evidenceId: "search-1", title: "ADK grounding", url: "https://adk.dev/grounding/google_search_grounding/", supportedText: "Grounded responses connect claims to sources." }];
    const metadata = {
      webSearchQueries: [request.question], searchEntryPoint: { renderedContent: "Search" },
      groundingChunks: [{ web: { title: evidence[0].title, uri: evidence[0].url } }],
      groundingSupports: [{ groundingChunkIndices: [0], segment: { text: evidence[0].supportedText } }],
    };
    expect(() => validateStrategySearchGrounding(request, evidence, metadata)).not.toThrow();
    expect(() => validateStrategySearchGrounding(null, evidence, metadata)).toThrow("exact research request");
    expect(() => validateStrategySearchGrounding(request, evidence, { ...metadata, groundingSupports: [] })).toThrow("absent from native grounding metadata");
  });
});
