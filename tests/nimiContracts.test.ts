import { describe, expect, it } from "vitest";
import { analysisSubmissionSchema, sourceAnalysisSchema } from "@/lib/contracts";
import { sourceAnalysisDigest } from "@/lib/sourceAnalysis";
import { validateAnalysisSearchGrounding } from "@/lib/analysisGrounding";

const analysis = () => ({
  sourceDigest: "a".repeat(64), summary: "Grounded source result.",
  moments: [{
    id: "moment-1", title: "Proof", startSec: 2, endSec: 8,
    hook: "Nine days became forty hours", quote: "We cut nine days to forty hours.",
    transcriptSegmentRefs: ["segment-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" as const,
  }],
  angles: [{
    id: "angle-1", angleType: "source_insight" as const, evidenceKind: "source" as const, title: "Time to value", rationale: "Use the measured result.",
    evidenceRefs: ["moment-1"], assumptions: [], confidence: "high" as const,
  }],
  assumptions: [], confidence: "high" as const,
});

describe("Nimi source analysis contracts", () => {
  it("accepts one complete strict persisted analysis", () => {
    expect(sourceAnalysisSchema.safeParse(analysis()).success).toBe(true);
    expect(analysisSubmissionSchema.safeParse({
      jobId: "job-1", stage: "understand", analysis: analysis(),
      analysisDigest: "b".repeat(64), modelUsed: "gemini-3.5-flash",
      researchRequest: null, searchEvidence: [], groundingMetadata: null,
    }).success).toBe(true);
  });

  it("matches the Python canonical SHA-256 analysis digest", () => {
    expect(sourceAnalysisDigest(analysis())).toBe("8d084355f09234c08410bf354c54ce89a3dec3bd057a4d56039c760b3f9cbae8");
  });

  it("rejects old projections, incomplete provenance, and duplicate ids", () => {
    expect(analysisSubmissionSchema.safeParse({
      jobId: "job-1", stage: "understand", summary: "legacy", moments: [], angles: [], modelUsed: "model",
    }).success).toBe(false);
    const missing = analysis();
    Reflect.deleteProperty(missing.moments[0], "transcriptSegmentRefs");
    expect(sourceAnalysisSchema.safeParse(missing).success).toBe(false);
    const duplicate = analysis();
    duplicate.angles[0].id = "moment-1";
    expect(sourceAnalysisSchema.safeParse(duplicate).success).toBe(false);
  });

  it("rejects invalid ranges, implicit visuals, and confident assumptions", () => {
    const range = analysis(); range.moments[0].startSec = 9;
    expect(sourceAnalysisSchema.safeParse(range).success).toBe(false);
    const visual = analysis(); Object.assign(visual.moments[0], { visualHook: "A chart" });
    expect(sourceAnalysisSchema.safeParse(visual).success).toBe(false);
    const assumption = { ...analysis(), assumptions: ["Unverified audience response"] };
    expect(sourceAnalysisSchema.safeParse(assumption).success).toBe(false);
  });

  it("validates exact public grounding and rejects provider mismatch", () => {
    const request = { id: "analysis-research-market", mode: "public_web" as const, question: "What current public context qualifies this source claim?", justification: "The requested analysis needs current external context." };
    const evidence = [{ evidenceId: "analysis-search-source-1", evidenceKind: "public_context" as const, supportedText: "Current context", title: "Primary source", url: "https://example.com/source" }];
    const metadata = {
      webSearchQueries: [request.question], searchEntryPoint: { renderedContent: "Search" },
      groundingChunks: [{ web: { title: "Primary source", uri: "https://example.com/source" } }],
      groundingSupports: [{ groundingChunkIndices: [0], segment: { text: "Current context" } }],
    };
    expect(() => validateAnalysisSearchGrounding(request, evidence, metadata)).not.toThrow();
    expect(() => validateAnalysisSearchGrounding(
      { ...request, mode: "private_index" }, evidence, metadata,
    )).toThrow();
    expect(() => validateAnalysisSearchGrounding(null, evidence, metadata)).toThrow();
  });
});
