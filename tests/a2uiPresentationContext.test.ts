import { describe, expect, it } from "vitest";
import { buildUiContext } from "../src/lib/a2ui/presentationContext";
import type { JobFull } from "../src/components/jobTypes";

const job: JobFull = {
  id: "job-1",
  status: "waiting_for_approval",
  stage: "awaiting_approval",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:01:00.000Z",
  config: { youtubeUrl: "https://www.youtube.com/watch?v=abcdefghijk", brief: "Launch from outcomes", platforms: ["x"] },
  ingestedTitle: "Founder launch interview",
  transcriptSegments: [{ id: "segment-1", startSec: 10, endSec: 20, text: "private transcript text" }],
  sourceAnalysis: { sourceDigest: "a".repeat(64), summary: "Outcome proof.", moments: [{ id: "moment-1", title: "Outcome proof", startSec: 10, endSec: 20, hook: "Proof", quote: "We cut setup time.", transcriptSegmentRefs: ["segment-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" }], angles: [{ id: "angle-1", angleType: "source_insight", evidenceKind: "source", title: "Outcome-led launch", rationale: "Lead with proof.", evidenceRefs: ["moment-1"], assumptions: [], confidence: "high" }], assumptions: [], confidence: "high" },
  drafts: [{ id: "draft-1", platform: "x", text: "full draft text must stay server-side", valid: true, momentId: "moment-1" }],
  actions: [{
    id: "publish-1",
    jobId: "job-1",
    type: "publish_x_post",
    title: "Publish launch post",
    description: "Send the selected launch draft.",
    risk: "high",
    requiresApproval: true,
    approvalState: "pending",
    payload: { text: "secret payload text", accessToken: "credential-value" },
    state: "planned",
  }],
  assets: [{ actionId: "image-1", mime: "image/png", sizeBytes: 512, digest: "asset-digest" }],
};

describe("A2UI presentation context", () => {
  it("includes identifiers and summaries but excludes authored content and action payloads", () => {
    const context = buildUiContext({
      runId: "run-1",
      message: "Show drafts",
      response: { intent: "list_drafts", reply: "Drafts ready.", jobId: "job-1" },
      job,
      receipts: [],
    });

    expect(context.drafts).toEqual([{ id: "draft-1", platform: "x", valid: true, momentId: "moment-1" }]);
    expect(context.actions).toEqual([{ id: "publish-1", type: "publish_x_post", pending: true }]);
    expect(context.sources).toEqual(expect.arrayContaining([
      { id: "source-video", kind: "video", label: "Founder launch interview" },
      { id: "segment-1", kind: "transcript", label: "Transcript 00:10–00:20" },
    ]));
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("full draft text");
    expect(serialized).not.toContain("private transcript text");
    expect(serialized).not.toContain("secret payload text");
    expect(serialized).not.toContain("credential-value");
    expect(serialized).not.toContain("youtube.com");
  });

  it("bounds every entity collection before schema validation", () => {
    const manyDrafts = Array.from({ length: 30 }, (_, index) => ({
      id: `draft-${index}`,
      platform: "x",
      text: `Draft ${index}`,
      valid: true,
    }));
    const context = buildUiContext({
      runId: "run-2",
      message: "Compare everything",
      response: { intent: "list_drafts", reply: "Ready.", jobId: "job-1" },
      job: { ...job, drafts: manyDrafts },
      receipts: [],
    });

    expect(context.drafts).toHaveLength(20);
  });
});
