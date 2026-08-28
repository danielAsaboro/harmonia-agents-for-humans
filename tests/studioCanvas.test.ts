import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaWorkspace } from "../src/components/studio/MediaWorkspace";
import { WorkingCanvas } from "../src/components/studio/WorkingCanvas";
import { surfaceRevisionRequest } from "../src/lib/a2ui/workspaceActions";

describe("studio canvas", () => {
  it("renders native audio only for a persisted audio asset", () => {
    const html = renderToStaticMarkup(createElement(MediaWorkspace, {
      kind: "audio",
      jobId: "job-1",
      assets: [{ actionId: "sound", kind: "audio", mime: "audio/mpeg", title: "Launch score", sizeBytes: 2400, digest: "d", provider: "lyria" }],
      selectedArtifactId: null,
      onSelect: () => {},
    }));
    expect(html).toContain("<audio");
    expect(html).toContain("Lyria");
    expect(html).toContain("/api/jobs/job-1/assets/sound");
  });

  it("shows an honest generated-video empty state", () => {
    const html = renderToStaticMarkup(createElement(MediaWorkspace, {
      kind: "motion", jobId: "job-1", assets: [], selectedArtifactId: null, onSelect: () => {},
    }));
    expect(html).toContain("No motion asset exists for this working set");
    expect(html).not.toContain("Veo generated");
  });

  it("mounts a generated canvas without a collapsed appendix label", () => {
    const html = renderToStaticMarkup(createElement(WorkingCanvas, {
      job: {
        id: "job-1", status: "running", stage: "draft", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
        config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, normalizedSources: [], actions: [], assets: [],
      },
      events: [], receipts: [], selectedArtifactId: null, onSelectedArtifactChange: () => {},
      operations: [
        { version: "v0.9", createSurface: { surfaceId: "studio-run-1-canvas-r1", catalogId: "https://harmonia.app/a2ui/catalogs/chat/v1" } },
        { version: "v0.9", updateComponents: { surfaceId: "studio-run-1-canvas-r1", components: [{ id: "root", component: "SurfaceEmpty", title: "Waiting", message: "No drafts yet", children: [], emphasis: "primary", agentFraming: false }] } },
      ],
    }));
    expect(html).not.toContain("Agent-generated interface");
    expect(html).not.toContain("<summary>Agent-generated");
  });

  it("turns a view revision into a normal grounded chat request", () => {
    expect(surfaceRevisionRequest("job-1", "draft-2")).toBe(
      "Show drafts for job job-1. Recompose the generated comparison around draft draft-2.",
    );
  });

  it("shows the operator retry control for a retryable persisted job failure", () => {
    const html = renderToStaticMarkup(createElement(WorkingCanvas, {
      job: {
        id: "job-retry", status: "failed", stage: "understand", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
        config: { sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, normalizedSources: [], actions: [], assets: [],
        failure: { stage: "understand", category: "dependency", code: "managed_dependency_unavailable", publicMessage: "A required dependency is temporarily unavailable.", retryable: true, operationId: "op-1", traceId: "a".repeat(32), attempt: 0, maxAttempts: 3, details: {}, at: "2026-08-23T00:00:00.000Z" },
      },
      events: [], receipts: [], selectedArtifactId: null, onSelectedArtifactChange: () => {}, onRetry: () => {},
    }));
    expect(html).toContain("A required dependency is temporarily unavailable.");
    expect(html).toContain(">Retry</button>");
  });
});
