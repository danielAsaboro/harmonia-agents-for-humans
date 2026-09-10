import { describe, expect, it } from "vitest";
import { buildEditorialPlanningSnapshot, EDITORIAL_PLANNING_POLICY_ID } from "@/lib/editorialPlanning";
import type { ContentItem, Job } from "@/lib/types";
import { sourceAnalysisDigest } from "@/lib/sourceAnalysis";
import { strategyFixture } from "./fixtures/strategy";

const job = {
  id: "job-1", stage: "plan", status: "running", workspaceId: "w1", brandId: "b1",
  controlEpoch: 1, controlState: "running",
  createdByUserId: "u1", createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z",
  config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, strategyDigest: "a".repeat(64), strategyRevision: 1,
  strategyApproval: { decision: "approved", payloadDigest: "a".repeat(64), revision: 1, actorSubjectId: "u1", decidedAt: "2026-08-31T00:00:00Z", expiresAt: "2026-09-01T00:00:00Z" },
  strategyRef: { workspaceId: "w1", brandId: "b1", strategyId: "strategy-1", revision: 8, digest: "a".repeat(64) },
  contentStrategy: strategyFixture("strategy-1"),
  sourceAnalysis: { sourceDigest: "c".repeat(64), summary: "Second source", moments: [{ id: "second-moment", title: "Proof", startSec: 0, endSec: 1, hook: "Proof", quote: "Proof", sourceSegmentRefs: ["second-source:seg-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" }], angles: [], assumptions: [], confidence: "high" },
} as Job;

const item = {
  id: "content-1", jobId: "older-job", text: "persisted", platforms: ["x"], status: "scheduled",
  publishMode: "approval", scheduledFor: "2026-09-02T16:00:00Z",
  googleCalendarSync: { status: "synced", calendarId: "primary", eventId: "event-1" },
  createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z",
} as ContentItem;

describe("deterministic Temi planning snapshot", () => {
  it("binds the pinned direction to this job's exact disjoint source evidence", () => {
    const snapshot = buildEditorialPlanningSnapshot(job, []);
    expect(snapshot.sourceBinding).toEqual({ jobId: job.id, strategyRef: job.strategyRef, analysisDigest: sourceAnalysisDigest(job.sourceAnalysis), evidenceIds: ["second-moment", "second-source:seg-1"] });
  });
  it("projects tenant-scoped commitments and calendar state without granting mutation authority", () => {
    const snapshot = buildEditorialPlanningSnapshot(job, [item], "2026-08-30T12:00:00Z");
    expect(snapshot.snapshotId).toBe("planning-job-1-v1");
    expect(snapshot.existingCommitments).toEqual([expect.objectContaining({ id: "commitment:content-1:x", channel: "x" })]);
    expect(snapshot.calendarProjection).toEqual([expect.objectContaining({ state: "synced", externalEventId: "event-1" })]);
    expect(snapshot.provenanceIds).toEqual([EDITORIAL_PLANNING_POLICY_ID, `strategy:${"a".repeat(64)}`, "content-item:content-1"].sort());
    expect(snapshot).not.toHaveProperty("credentials");
    expect(snapshot).not.toHaveProperty("calendarWriteToken");
  });

  it("rejects missing or mismatched approved strategy authority", () => {
    expect(() => buildEditorialPlanningSnapshot({ ...job, strategyApproval: undefined }, [])).toThrow("approved strategy");
    expect(() => buildEditorialPlanningSnapshot({ ...job, strategyApproval: { ...job.strategyApproval!, payloadDigest: "b".repeat(64) } }, [])).toThrow("binding mismatch");
  });

  it("binds each replan to a new snapshot revision", () => {
    expect(buildEditorialPlanningSnapshot({ ...job, editorialPlanRevision: 2 }, []).snapshotId).toBe("planning-job-1-v2");
  });
});
