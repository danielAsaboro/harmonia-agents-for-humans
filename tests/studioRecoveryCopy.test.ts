import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("studio recovery controls", () => {
  it("uses a release-aware recovery control for a permanent protocol failure", () => {
    const states = readFileSync("src/components/studio/StudioStates.tsx", "utf8");
    const canvas = readFileSync("src/components/studio/WorkingCanvas.tsx", "utf8");
    expect(states).toContain("A code or contract correction must be deployed before this job can be resumed.");
    expect(states).toContain("Resume corrected job");
    expect(canvas).toContain("onRetryAfterFix={!job.failure.retryable ? onRetry : undefined}");
  });
});
