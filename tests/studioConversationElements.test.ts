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
      message: { role: "assistant", text: "Artifact ready", data: { intent: "list_artifacts", reply: "", jobId: "job-1", artifacts: [{ id: "d1", jobId: "job-1", outputPlanId: "p1", outputPlanDigest: "a".repeat(64), outputType: "x_post", revision: 1, title: "Launch", sourceSegmentRefs: ["s:1"], producer: { role: "noni", model: "gemini-3.5-flash", traceId: "b".repeat(32) }, review: { role: "dara", traceId: "c".repeat(32), decision: "accept" }, mimeType: "text/markdown", createdAt: "2026-08-30T00:00:00.000Z", payload: { kind: "x_post", text: "Ship it" }, contentDigest: "d".repeat(64) }] } },
      onActivateArtifact: () => {},
    }));
    expect(html).toContain('data-artifact-id="artifact:d1"');
    expect(html).toContain("Ship it");
  });
});
