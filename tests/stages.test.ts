import { describe, expect, it } from "vitest";
import { TransitionError, assertTransition, isKnownStage, nextStage } from "@/lib/stages";

describe("stage pipeline", () => {
  it("walks the linear pipeline", () => {
    const path: string[] = [];
    let stage: string | null = "ingest";
    while (stage) {
      path.push(stage);
      stage = nextStage(stage as never);
      if (path.length > 20) throw new Error("cycle");
    }
    expect(path).toEqual(["ingest", "transcribe", "understand", "strategize", "awaiting_strategy_approval"]);
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
    expect(() => assertTransition("understand", "transcribe")).toThrow(TransitionError);
    expect(() => assertTransition("transcribe", "transcribe")).not.toThrow();
  });

  it("validates known stages", () => {
    expect(isKnownStage("draft")).toBe(true);
    expect(isKnownStage("bogus")).toBe(false);
  });
});
