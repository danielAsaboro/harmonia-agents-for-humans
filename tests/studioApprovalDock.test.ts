import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalDock } from "../src/components/studio/ApprovalDock";

describe("ApprovalDock", () => {
  it("renders controls only for real pending planned actions", () => {
    const html = renderToStaticMarkup(createElement(ApprovalDock, {
      jobId: "job-1",
      actions: [
        { id: "pending", jobId: "job-1", type: "publish_x_post", title: "Publish", description: "", risk: "high", requiresApproval: true, approvalState: "pending", payload: {}, state: "planned" },
        { id: "done", jobId: "job-1", type: "generate_image", title: "Image", description: "", risk: "low", requiresApproval: false, approvalState: "not_required", payload: {}, state: "executed" },
      ],
      verifications: [], receipts: [], busy: false, onDecide: async () => {},
    }));
    expect(html).toContain('data-action-id="pending"');
    expect(html).not.toContain('data-action-id="done"');
    expect(html).toContain("Publishing remains blocked");
  });
});
