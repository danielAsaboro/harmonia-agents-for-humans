import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { engagementSubmissionSchema } from "@/lib/contracts";
import { priorInsightsFromJob } from "@/lib/repository";

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/insights-contract.json"), "utf8"));

describe("engagement insight wire contract", () => {
  it("requires the measurement timestamp that the downstream contract preserves", () => {
    const row = fixture.topPosts[0];
    const submission = {
      jobId: row.jobId,
      stage: "learn",
      engagement: [{
        actionId: row.actionId,
        postId: row.postId,
        ...row.metrics,
      }],
      learnings: { summary: "Measured a verified published post." },
    };

    expect(engagementSubmissionSchema.safeParse(submission).success).toBe(false);
    expect(engagementSubmissionSchema.parse({
      ...submission,
      engagement: [{ ...submission.engagement[0], checkedAt: row.checkedAt }],
    }).engagement[0].checkedAt).toBe(row.checkedAt);
  });

  it("serializes verified measurements and names every unavailable persistence gap", () => {
    const text = fixture.topPosts[0].text;
    const action = (id: string) => ({
      id,
      jobId: "job-measured-001",
      type: "publish_x_post" as const,
      title: "Published post",
      description: "Approved post",
      risk: "high" as const,
      requiresApproval: true,
      approvalState: "approved" as const,
      payload: { text },
      state: "executed" as const,
    });
    const measurement = (actionId: string, postId: string, checkedAt: string) => ({
      actionId,
      postId,
      checkedAt,
      ...fixture.topPosts[0].metrics,
    });
    const verification = (actionId: string, checkedAt: string) => ({
      id: `verification-${actionId}`,
      target: "x:post-123",
      actionId,
      receiptId: `receipt-${actionId}`,
      operationId: `verify-${actionId}`,
      traceId: "a".repeat(32),
      verified: true,
      method: "official_api_readback" as const,
      evidence: {
        kind: "x_api" as const,
        url: fixture.topPosts[0].durableEvidenceRef,
        fetchedAt: checkedAt,
        digest: "fc23e4b060e1706a6c9251631074a16f7b6c4029d895897f6822a834ad34b439",
      },
      checkedAt,
    });
    const rows = [
      ...priorInsightsFromJob("job-measured-001", {
        actions: [action("action-publish-001")],
        verifications: [verification("action-publish-001", fixture.topPosts[0].checkedAt)],
        engagement: [measurement("action-publish-001", "post-123", fixture.topPosts[0].checkedAt)],
      }),
      ...priorInsightsFromJob("job-missing-action", {
        actions: [], verifications: [],
        engagement: [measurement("action-missing", "post-missing-action", fixture.topPosts[0].checkedAt)],
      }),
      ...priorInsightsFromJob("job-stale-verification", {
        actions: [action("action-stale")],
        verifications: [verification("action-stale", "2026-09-09T10:16:00.000Z")],
        engagement: [measurement("action-stale", "post-stale", fixture.topPosts[0].checkedAt)],
      }),
      ...priorInsightsFromJob("job-unverified", {
        actions: [action("action-unverified")], verifications: [],
        engagement: [measurement("action-unverified", "post-unverified", fixture.topPosts[0].checkedAt)],
      }),
    ];

    expect(JSON.parse(JSON.stringify(rows))).toEqual(fixture.topPosts);
  });
});
