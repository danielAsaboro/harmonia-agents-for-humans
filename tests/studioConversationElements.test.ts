import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentRunSummary } from "../src/components/studio/AgentRunSummary";
import { ConversationTurn } from "../src/components/studio/ConversationTurn";
import { initialChatRunState } from "../src/lib/a2ui/chatReducer";

describe("studio conversation elements", () => {
  it("collapses completed activity but opens failures", () => {
    const complete = { ...initialChatRunState("r1"), status: "complete" as const, text: "Done" };
    const failed = { ...initialChatRunState("r2"), status: "failed" as const, error: "provider unavailable" };
    expect(renderToStaticMarkup(createElement(AgentRunSummary, { run: complete }))).not.toContain("<details open");
    expect(renderToStaticMarkup(createElement(AgentRunSummary, { run: failed }))).toContain("<details open");
  });

  it("renders artifact references as real canvas targets", () => {
    const html = renderToStaticMarkup(createElement(ConversationTurn, {
      message: { role: "assistant", text: "Draft ready", data: { intent: "list_drafts", reply: "", jobId: "job-1", drafts: [{ id: "d1", platform: "x", text: "Ship it", valid: true }] } },
      onActivateArtifact: () => {},
    }));
    expect(html).toContain('data-artifact-id="draft:d1"');
    expect(html).toContain("Ship it");
  });
});
