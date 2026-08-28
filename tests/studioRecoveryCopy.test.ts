import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("studio recovery controls", () => {
  it("lets an operator retry a permanent protocol failure after a code fix", () => {
    const states = readFileSync("src/components/studio/StudioStates.tsx", "utf8");
    const canvas = readFileSync("src/components/studio/WorkingCanvas.tsx", "utf8");
    expect(states).toContain("Retry after fix");
    expect(canvas).toContain("permanent={!job.failure.retryable} onRetry={onRetry}");
  });
});
