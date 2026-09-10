import { describe, expect, it } from "vitest";
import { latestSurfaceParts } from "../src/lib/ai-sdk/surfaceSlots";

function revision(slot: "canvas" | "conversation" | "approval", revision: number, child: string) {
  const surfaceId = `studio-run-1-${slot}-r${revision}`;
  return { type: "data-harmonia-surface", id: surfaceId, data: { surfaceId, slot, revision, components: [
    { id: "root", component: "Column", children: [child] },
    { id: child, component: "SurfaceEmpty", title: `Revision ${revision}`, message: "No content", children: [], emphasis: "primary", agentFraming: false, tone: "paper", role: "support", density: "balanced", motion: "none", surfaceRhythm: "editorial", surfaceComposition: "stack", surfaceEnergy: "quiet", revision },
  ] } };
}

describe("AI SDK studio surface slots", () => {
  it("returns the latest validated revision for one slot", () => {
    const selected = latestSurfaceParts([revision("canvas", 1, "old"), revision("approval", 8, "approval"), revision("canvas", 2, "drafts")], "canvas");
    expect(selected).toHaveLength(1);
    expect(selected[0].data.revision).toBe(2);
    expect(selected[0].data.components[0]).toMatchObject({ id: "root", children: ["drafts"] });
  });
  it("rejects unvalidated protocol input", () => {
    expect(() => latestSurfaceParts([{ createSurface: {} }], "canvas")).toThrow();
  });
});
