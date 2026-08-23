import { describe, expect, it } from "vitest";
import { buildDemoChatRunEvents } from "../scripts/demo-a2ui-events.mjs";
import { partitionStudioOperations } from "../src/lib/a2ui/studioRegions";

describe("A2UI studio regions", () => {
  it("places validated A2UI components by product role", () => {
    const events = buildDemoChatRunEvents({
      runId: "r1", startedAt: "2026-08-23T00:00:00.000Z", completedAt: "2026-08-23T00:00:01.000Z",
      jobId: "job-1", confirmationJobId: "job-2", confirmationActionId: "action-1",
      imageSizeBytes: 1, clipSizeBytes: 1, reelSizeBytes: 1,
    }) as Array<{ type: string; operation?: unknown }>;
    const operations = events.filter((event) => event.type === "a2ui_operation").map((event) => event.operation);
    const regions = partitionStudioOperations("r1", operations);
    expect(JSON.stringify(regions.conversation)).toContain("ReasoningSummary");
    expect(JSON.stringify(regions.canvas)).toContain("AttachmentCard");
    expect(JSON.stringify(regions.approval)).toContain("Confirmation");
    expect(JSON.stringify(regions.conversation)).not.toContain("Confirmation");
  });

  it("rejects dangling child references before rendering", () => {
    expect(() => partitionStudioOperations("r2", [
      { version: "v0.9", createSurface: { surfaceId: "s", catalogId: "https://harmonia.app/a2ui/catalogs/chat/v1" } },
      { version: "v0.9", updateComponents: { surfaceId: "s", components: [{ id: "root", component: "Column", children: ["missing"] }] } },
    ])).toThrow("dangling child");
  });
});
