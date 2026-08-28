import { describe, expect, it } from "vitest";
import { contentArtifactDigest, sealContentArtifact } from "@/lib/contentArtifacts/digest";
import { contentArtifactSchema } from "@/lib/contentArtifacts/contracts";
import type { ContentArtifact } from "@/lib/contentArtifacts/contracts";

const base = {
  id: "artifact-1", jobId: "job-1", outputPlanId: "plan-1", outputPlanDigest: "a".repeat(64),
  outputType: "newsletter" as const, revision: 1, title: "Launch note",
  sourceSegmentRefs: ["source-1:seg-1"],
  producer: { role: "noni_copywriter", model: "gemini-3.5-flash", traceId: "b".repeat(32) },
  review: { role: "dara_editor", traceId: "c".repeat(32), decision: "accept" as const },
  mimeType: "text/markdown" as const, createdAt: "2026-08-30T00:00:00.000Z",
  payload: { kind: "newsletter" as const, subject: "Launch", preheader: "What changed", introduction: "Intro", sections: [{ id: "s1", heading: "Proof", body: "Body", sourceSegmentRefs: ["source-1:seg-1"] }], cta: "Try it" },
} satisfies Omit<ContentArtifact, "contentDigest">;

describe("content artifact contracts", () => {
  it("seals a strict typed artifact with a stable canonical digest", () => {
    const sealed = sealContentArtifact(base);
    expect(contentArtifactSchema.parse(sealed)).toEqual(sealed);
    expect(contentArtifactDigest(sealed)).toBe(sealed.contentDigest);
    expect(sealed.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sealContentArtifact({ ...base, revision: 2 }).contentDigest).not.toBe(sealed.contentDigest);
  });

  it("rejects duplicate ordered item ids and output/payload mismatch", () => {
    const duplicate = { ...base, payload: { ...base.payload, sections: [base.payload.sections[0], base.payload.sections[0]] } };
    expect(contentArtifactSchema.safeParse({ ...duplicate, contentDigest: "d".repeat(64) }).success).toBe(false);
    expect(contentArtifactSchema.safeParse({ ...base, outputType: "blog_article", contentDigest: "d".repeat(64) }).success).toBe(false);
  });
});
