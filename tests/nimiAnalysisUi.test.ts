import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { JobFull } from "@/components/jobTypes";
import { SourcesWorkspace } from "@/components/studio/SourcesWorkspace";

describe("Nimi persisted analysis UI", () => {
  it("renders source and analysis digests, grounding, assumptions, and confidence", () => {
    const job = {
      id: "job-1", status: "running", stage: "strategize",
      createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:01:00Z",
      config: { platforms: ["x"] }, drafts: [], actions: [],
      transcriptSegments: [{ id: "segment-1", startSec: 2, endSec: 8, text: "We cut nine days to forty hours." }],
      analysisDigest: "b".repeat(64),
      sourceAnalysis: {
        sourceDigest: "a".repeat(64), summary: "A grounded activation result.", confidence: "medium",
        assumptions: ["The result applies only to the described workflow."],
        moments: [{ id: "moment-1", title: "Activation compression", startSec: 2, endSec: 8,
          hook: "Nine days became forty hours", quote: "We cut nine days to forty hours.",
          transcriptSegmentRefs: ["segment-1"], visualHook: "Founder shows the chart",
          cropSuitability: "good", captionSafeRegion: "lower third", visualEvidenceIds: ["frame-1"],
          assumptions: [], confidence: "high" }],
        angles: [{ id: "angle-1", kind: "memory", title: "Concise proof", rationale: "Use eligible prior learning.",
          evidenceRefs: ["memory-1"], assumptions: ["Preference remains applicable."], confidence: "medium" }],
      },
    } as JobFull;
    const html = renderToStaticMarkup(createElement(SourcesWorkspace, { job, receipts: [] }));
    for (const value of ["Nimi source analysis", "A grounded activation result", "segment-1", "frame-1",
      "memory-1", "medium", "The result applies only", "Preference remains applicable", "a".repeat(64), "b".repeat(64)]) {
      expect(html).toContain(value);
    }
  });
});
