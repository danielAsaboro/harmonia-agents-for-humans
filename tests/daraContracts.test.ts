import { describe, expect, it } from "vitest";
import { editorialAssessmentSchema } from "@/lib/contracts";

const dimensions = ["grounding", "brief_alignment", "brand_voice", "platform_constraints", "cta", "safety", "clarity"] as const;

function assessment(): { verdict: "accepted" | "revise"; checks: Array<{ dimension: typeof dimensions[number]; status: "pass" | "fail"; rationale: string; evidenceRefs: string[]; constraintRefs: string[] }>; issues: Array<{ id: string; category: typeof dimensions[number]; severity: "low" | "medium" | "high"; fieldPath: string; instruction: string; evidenceRefs: string[]; constraintRefs: string[] }>; resolvedIssueIds: string[] } {
  return {
    verdict: "accepted",
    checks: dimensions.map((dimension) => ({
      dimension, status: "pass", rationale: `The draft passes ${dimension} review.`,
      evidenceRefs: dimension === "grounding" ? ["moment-1"] : [],
      constraintRefs: dimension === "safety" ? ["No unverified metrics"] : [],
    })),
    issues: [], resolvedIssueIds: [],
  };
}

describe("Dara assessment contract", () => {
  it("accepts all seven checks without workflow-owned metadata", () => {
    expect(editorialAssessmentSchema.parse(assessment()).checks).toHaveLength(7);
    expect(editorialAssessmentSchema.safeParse({ ...assessment(), reviewedAt: "2026-08-27T10:00:00Z" }).success).toBe(false);
  });

  it("rejects missing dimensions and false acceptance", () => {
    expect(editorialAssessmentSchema.safeParse({ ...assessment(), checks: assessment().checks.slice(0, 6) }).success).toBe(false);
    const failed = assessment();
    failed.checks[0].status = "fail";
    expect(editorialAssessmentSchema.safeParse(failed).success).toBe(false);
  });

  it("requires revise issues to exactly cover failed dimensions and closed paths", () => {
    const revised = assessment();
    revised.verdict = "revise";
    revised.checks[6].status = "fail";
    revised.issues = [{ id: "issue-1", category: "clarity", severity: "medium", fieldPath: "text", instruction: "Make the sentence clearer.", evidenceRefs: [], constraintRefs: [] }];
    expect(editorialAssessmentSchema.safeParse(revised).success).toBe(true);
    expect(editorialAssessmentSchema.safeParse({ ...revised, issues: [{ ...revised.issues[0], fieldPath: "claims.0.text" }] }).success).toBe(false);
    expect(editorialAssessmentSchema.safeParse({ ...revised, issues: [{ ...revised.issues[0], category: "cta" }] }).success).toBe(false);
  });
});
