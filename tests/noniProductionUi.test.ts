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
      config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, normalizedSources: [], drafts: [], actions: [],
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

  it("renders Dara's complete rubric, failed issue provenance, and verified resolution", () => {
    const checks = ["grounding", "brief_alignment", "brand_voice", "platform_constraints", "cta", "safety", "clarity"].map((dimension) => ({ dimension, status: dimension === "clarity" ? "fail" as const : "pass" as const, rationale: `Checked ${dimension}.`, evidenceRefs: dimension === "grounding" ? ["moment-1"] : [], constraintRefs: dimension === "safety" ? ["No unverified metrics"] : [] })) as import("@/lib/types").EditorialCheck[];
    const revised = { ...draft, id: "draft-2", revision: 2 as const, priorDraftId: "draft-1", addressedIssueIds: ["issue-1"] };
    const job = {
      id: "job-2", status: "running", stage: "draft", createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:02:00Z",
      config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, normalizedSources: [], drafts: [], actions: [],
      productionTrace: {
        originalDraft: draft, revisionDraft: revised, acceptedDraft: revised,
        reviews: [
          { id: "review-1", planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64), editorialItemId: "item-1", briefId: "brief-1", draftId: "draft-1", revision: 1 as const, verdict: "revise" as const, reviewedAt: "2026-08-27T00:01:00Z", checks, issues: [{ id: "issue-1", category: "clarity" as const, severity: "medium" as const, fieldPath: "text" as const, instruction: "Clarify the source qualification.", evidenceRefs: ["moment-1"], constraintRefs: [] }], resolvedIssueIds: [] },
          { id: "review-2", planId: "plan-1", planDigest: "a".repeat(64), strategyDigest: "b".repeat(64), editorialItemId: "item-1", briefId: "brief-1", draftId: "draft-2", revision: 2 as const, verdict: "accepted" as const, reviewedAt: "2026-08-27T00:02:00Z", checks: checks.map((check) => ({ ...check, status: "pass" as const })), issues: [], resolvedIssueIds: ["issue-1"] },
        ],
      },
    } satisfies JobFull;
    const html = renderToStaticMarkup(createElement(SourcesWorkspace, { job, receipts: [] }));
    for (const value of ["Checked grounding.", "Checked platform_constraints.", "Clarify the source qualification.", "moment-1", "No unverified metrics", "Resolved: issue-1", "Aug 27, 2026"])
      expect(html).toContain(value);
  });
});
