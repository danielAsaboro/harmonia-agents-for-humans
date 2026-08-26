import { describe, expect, it } from "vitest";
import { analysisSubmissionSchema, sourceAnalysisSchema } from "@/lib/contracts";
import { sourceAnalysisDigest } from "@/lib/sourceAnalysis";

const analysis = () => ({
  sourceDigest: "a".repeat(64), summary: "Grounded source result.",
  moments: [{
    id: "moment-1", title: "Proof", startSec: 2, endSec: 8,
    hook: "Nine days became forty hours", quote: "We cut nine days to forty hours.",
    transcriptSegmentRefs: ["segment-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" as const,
  }],
  angles: [{
    id: "angle-1", kind: "source" as const, title: "Time to value", rationale: "Use the measured result.",
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
    }).success).toBe(true);
  });

  it("matches the Python canonical SHA-256 analysis digest", () => {
    expect(sourceAnalysisDigest(analysis())).toBe("3dbe2ad35b2894f4b963088f2b4a220c598779733773519d43e6ba77e686a933");
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
});
