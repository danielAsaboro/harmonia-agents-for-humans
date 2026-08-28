import { describe, expect, it } from "vitest";
import { buildStudioWorkspace } from "../src/lib/studio/workspaceModel";

describe("studio workspace model", () => {
  it("groups only persisted artifacts by action and MIME", () => {
    const model = buildStudioWorkspace({
      id: "job-1", status: "complete", stage: "complete", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
      config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, normalizedSources: [], drafts: [],
      actions: [
        { id: "img", jobId: "job-1", type: "generate_image", title: "Launch visual", description: "", risk: "low", requiresApproval: false, approvalState: "not_required", payload: {}, state: "executed" },
        { id: "sound", jobId: "job-1", type: "generate_lyria_soundtrack", title: "Launch score", description: "", risk: "low", requiresApproval: false, approvalState: "not_required", payload: {}, state: "executed" },
      ],
      assets: [
        { actionId: "img", mime: "image/png", sizeBytes: 1200, digest: "a" },
        { actionId: "sound", mime: "audio/mpeg", sizeBytes: 2400, digest: "b" },
      ],
    }, []);
    expect(model.visual.map((asset) => asset.actionId)).toEqual(["img"]);
    expect(model.audio.map((asset) => [asset.actionId, asset.provider])).toEqual([["sound", "lyria"]]);
    expect(model.motion).toEqual([]);
  });

  it("marks a draft reference invalid when its moment is absent", () => {
    const model = buildStudioWorkspace({
      id: "job-2", status: "complete", stage: "complete", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
      config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, normalizedSources: [],
      drafts: [{ id: "d1", platform: "x", text: "Grounded claim", valid: true, momentId: "missing" }], actions: [], assets: [],
    }, []);
    expect(model.traceLinks).toEqual([
      expect.objectContaining({ draftId: "d1", valid: false, error: "moment missing not found" }),
    ]);
  });
});
