import { describe, expect, it } from "vitest";
import { currentJobProgressParts } from "../src/lib/ai-sdk/liveJobProgress";

const part = { type: "data-harmonia-surface", id: "studio-run-canvas-r1", data: { surfaceId: "studio-run-canvas-r1", slot: "canvas", revision: 1, components: [{ id: "root", component: "Column", children: ["progress"] }, { id: "progress", component: "JobProgress", jobId: "job-1", title: "Job Status", stage: "collect_sources", status: "running", stages: [], children: [], emphasis: "primary", agentFraming: true, tone: "paper", role: "support", density: "balanced", motion: "none", surfaceRhythm: "operational", surfaceComposition: "stack", surfaceEnergy: "active", revision: 1 }] } };

describe("live generated job progress", () => {
  it("hydrates current persisted state without mutating history", () => {
    const result = currentJobProgressParts([part], { id: "job-1", stage: "complete", status: "complete" });
    expect(JSON.stringify(result)).toContain('"stage":"complete"');
    expect(JSON.stringify(part)).toContain('"stage":"collect_sources"');
  });
  it("refuses to relabel another job", () => expect(() => currentJobProgressParts([part], { id: "job-2", stage: "draft", status: "running" })).toThrow("different job"));
  it("shows the real failed stage", () => expect(JSON.stringify(currentJobProgressParts([part], { id: "job-1", stage: "draft", status: "failed" }))).toContain('"id":"draft","label":"draft","status":"failed"'));
});
