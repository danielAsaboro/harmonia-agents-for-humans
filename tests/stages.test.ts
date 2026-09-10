import { describe, expect, it } from "vitest";
import { TransitionError, assertTransition, isKnownStage, nextStage } from "@/lib/stages";

describe("stage pipeline", () => {
  it("routes jobs with pinned strategy directly from understanding to planning", () => {
    expect(nextStage("understand", { workspaceId: "w", brandId: "b", strategyId: "s", revision: 31, digest: "a".repeat(64) })).toBe("plan");
  });
  it("walks the linear pipeline", () => {
    const path: string[] = [];
    let stage: string | null = "collect_sources";
    while (stage) {
      path.push(stage);
      stage = nextStage(stage as never);
      if (path.length > 20) throw new Error("cycle");
    }
    expect(path).toEqual(["collect_sources", "extract_sources", "understand", "strategize", "awaiting_strategy_approval"]);
  });

  it("places durable planning before production drafting", () => {
    expect(nextStage("plan")).toBe("draft");
    expect(isKnownStage("plan")).toBe(true);
  });

  it("has no successor for terminal stages", () => {
    expect(nextStage("publish")).toBeNull();
    expect(nextStage("verify")).toBeNull();
    expect(nextStage("complete")).toBeNull();
    expect(nextStage("failed")).toBeNull();
  });

  it("rejects out-of-order results", () => {
    expect(() => assertTransition("understand", "extract_sources")).toThrow(TransitionError);
    expect(() => assertTransition("extract_sources", "extract_sources")).not.toThrow();
  });

  it("validates known stages", () => {
    expect(isKnownStage("draft")).toBe(true);
    expect(isKnownStage("packet")).toBe(false);
    expect(isKnownStage("bogus")).toBe(false);
  });
});
