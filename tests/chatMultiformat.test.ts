import { describe, expect, it } from "vitest";

import { parseLocalIntent } from "@/lib/chatIntent";

describe("multiformat chat intent", () => {
  it("requests persisted content artifacts instead of legacy X-only drafts", () => {
    expect(parseLocalIntent("show artifacts for job job-123")).toEqual({
      intent: "list_artifacts", jobId: "job-123",
    });
  });

  it("passes exact registry output kinds into a new content operation", () => {
    const parsed = parseLocalIntent("Create content from https://example.com/launch\nDesired outputs: newsletter, carousel_spec");
    expect(parsed.intent).toBe("create_job");
    expect(parsed.desiredOutputs).toEqual(["newsletter", "carousel_spec"]);
  });
});
