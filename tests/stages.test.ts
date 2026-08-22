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
    expect(path).toEqual(["ingest", "normalize", "collect", "evaluate", "plan", "awaiting_approval"]);
  });

  it("has no successor for terminal stages", () => {
    expect(nextStage("act")).toBeNull();
    expect(nextStage("verify")).toBeNull();
    expect(nextStage("complete")).toBeNull();
    expect(nextStage("failed")).toBeNull();
  });

  it("rejects out-of-order results", () => {
    expect(() => assertTransition("collect", "normalize")).toThrow(TransitionError);
    expect(() => assertTransition("normalize", "normalize")).not.toThrow();
  });

  it("validates known stages", () => {
    expect(isKnownStage("evaluate")).toBe(true);
    expect(isKnownStage("bogus")).toBe(false);
  });
});
