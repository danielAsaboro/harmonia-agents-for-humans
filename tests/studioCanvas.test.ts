import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaWorkspace } from "../src/components/studio/MediaWorkspace";
import { WorkingCanvas } from "../src/components/studio/WorkingCanvas";

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
        config: { brief: "Launch", platforms: ["x"] }, transcriptSegments: [], moments: [], angles: [], drafts: [], actions: [], assets: [],
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
});
