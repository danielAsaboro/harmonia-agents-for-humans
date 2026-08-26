import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { JobFull } from "@/components/jobTypes";
import { SourcesWorkspace } from "@/components/studio/SourcesWorkspace";

const draft = {
  id: "draft-1", planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64),
  editorialItemId: "item-1", briefId: "brief-1", revision: 1 as const, platform: "x" as const,
  format: "text_post" as const, audienceId: "founders", objective: "Show operating proof",
  funnelStage: "consideration" as const, ctaIntent: "request a demo",
  text: "We cut nine days to forty hours. Request a demo.", ctaTreatment: "Request a demo.",
  intendedConversion: "qualified demo request", evidenceRefs: ["moment-1"],
  claims: [{ text: "We cut nine days to forty hours.", evidenceRefs: ["moment-1"] }],
  assumptions: ["A direct hook suits X."], confidence: "high" as const,
  appliedConstraints: ["No unverified metrics"], priorDraftId: null, addressedIssueIds: [],
};

describe("Noni and Dara persisted production trace", () => {
  it("renders accepted copy, grounding, constraints, confidence, review, and digest", () => {
    const job = {
      id: "job-1", status: "running", stage: "draft", createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:01:00Z",
      config: { platforms: ["x"] }, transcriptSegments: [], moments: [], angles: [], drafts: [], actions: [],
      productionTraceDigest: "c".repeat(64),
      productionTrace: {
        originalDraft: draft, revisionDraft: null, acceptedDraft: draft,
        reviews: [{ id: "review-1", planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64), editorialItemId: "item-1", briefId: "brief-1", draftId: "draft-1", revision: 1 as const, verdict: "accepted" as const, reviewedAt: "2026-08-27T00:01:00Z", checks: ["grounding", "brief_alignment", "brand_voice", "platform_constraints", "cta", "safety", "clarity"].map((dimension) => ({ dimension, status: "pass", rationale: `Checked ${dimension}.`, evidenceRefs: [], constraintRefs: [] })) as import("@/lib/types").EditorialCheck[], issues: [], resolvedIssueIds: [] }],
      },
    } satisfies JobFull;
    const html = renderToStaticMarkup(createElement(SourcesWorkspace, { job, receipts: [] }));
    for (const value of ["Noni writing", "Dara review", "Accepted draft", "revision 1", draft.text, "moment-1", "No unverified metrics", "A direct hook suits X", "high confidence", "Dara revision 1", "accepted", "Trace digest"])
      expect(html).toContain(value);
  });
});
