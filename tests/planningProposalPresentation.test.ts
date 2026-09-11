import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { projectPlanningProposal } from "@/lib/workspaceContentContext";

describe("exact planning proposal review", () => {
  it("projects strategy rebase authority as an actionable revision proposal", () => {
    const projection = projectPlanningProposal({ id: "a".repeat(64), type: "strategy_rebase", state: "pending_approval", expectedPlanRef: { id: "plan", revision: 7 }, targetStrategyRef: { strategyId: "direction", revision: 3 }, guarded: [] });
    expect(projection.kind).toBe("strategy_rebase");
    expect(projection.changes).toContain('expectedPlanRef={"id":"plan","revision":7}');
  });
  it("shows source selection and guarded revision with accept, reject and cancel controls", async () => {
    const { PlanningProposalDecisionView } = await import("@/components/PlanningProposalReview");
    const html = renderToStaticMarkup(createElement(PlanningProposalDecisionView, { proposal: { type: "source_replacement", state: "pending_approval", sourceHandles: [{ kind: "web", url: "https://example.com/current" }], expectedPlanRef: { id: "plan", revision: 7 } }, authorityDigest: "b".repeat(64), busy: false, onDecide: () => {} }));
    expect(html).toContain("https://example.com/current"); expect(html).toContain("Accept replacement sources"); expect(html).toContain("Keep existing sources"); expect(html).toContain("Cancel queued work"); expect(html).toContain("b".repeat(64));
  });
  it("exposes no decision controls for an already resolved record", async () => {
    const { PlanningProposalDecisionView } = await import("@/components/PlanningProposalReview");
    const html = renderToStaticMarkup(createElement(PlanningProposalDecisionView, { proposal: { type: "strategy_rebase", state: "approved" }, authorityDigest: "b".repeat(64), busy: false, onDecide: () => {} }));
    expect(html).not.toContain("<button");
  });
});
