import { describe, expect, test } from "vitest";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { harmoniaCatalog, parseHarmoniaA2uiOperation } from "../src/components/a2ui/HarmoniaCatalog";
import { buildResponseSurface } from "../src/lib/a2ui/responseSurface";

describe("Harmonia A2UI surfaces", () => {
  test("the official processor accepts and materializes a generated job surface", () => {
    const operations = buildResponseSurface("run-1", {
      intent: "status",
      reply: "Job is drafting.",
      job: { id: "job-1", stage: "draft", status: "running", title: "Launch" },
    });
    const processor = new MessageProcessor([harmoniaCatalog]);

    processor.processMessages(operations as never[]);

    const surface = processor.model.getSurface("chat-run-1");
    expect(surface?.componentsModel.get("root")).toBeTruthy();
    expect(surface?.componentsModel.get("message")?.properties.text).toBe("Job is drafting.");
    expect(surface?.componentsModel.get("job-plan")).toBeTruthy();
  });

  test("the trusted host rejects unknown components before processing", () => {
    expect(() => parseHarmoniaA2uiOperation({
      version: "v0.9",
      updateComponents: { surfaceId: "s1", components: [{ id: "root", component: "ArbitraryHtml", html: "<script />" }] },
    })).toThrow("not registered");
  });

  test("preserves drafts, generated assets, and existing action confirmations", () => {
    const operations = buildResponseSurface("run-2", {
      intent: "list_drafts",
      reply: "One reviewed draft is ready.",
      jobId: "job-2",
      drafts: [{ id: "draft-1", platform: "x", text: "Ship the work.", momentId: "moment-1", valid: true }],
      assets: [{ actionId: "asset-1", mime: "image/png" }],
      pendingActions: [{ id: "action-1", title: "Publish post", type: "publish_x_post", risk: "high" }],
    });
    const update = operations[1] as { updateComponents: { components: Array<Record<string, unknown>> } };

    expect(update.updateComponents.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "MessageContent", text: "Ship the work." }),
      expect.objectContaining({ component: "AttachmentCard", previewUrl: "/api/jobs/job-2/assets/asset-1" }),
      expect.objectContaining({ component: "Confirmation", jobId: "job-2", actionId: "action-1" }),
    ]));
  });
});
