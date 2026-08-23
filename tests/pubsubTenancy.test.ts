import { describe, expect, it } from "vitest";
import { buildStageMessage } from "@/lib/pubsub";

describe("tenant-bound stage messages", () => {
  it("carries the durable workspace and brand with the job", () => {
    const built = buildStageMessage(
      { workspaceId: "workspace-a", brandId: "brand-a" },
      "job-1",
      "understand",
      0,
    );
    expect(JSON.parse(built.data.toString("utf8"))).toEqual({
      workspaceId: "workspace-a",
      brandId: "brand-a",
      jobId: "job-1",
      stage: "understand",
      attempt: 0,
    });
    expect(built.attributes.workspaceId).toBe("workspace-a");
  });
});
