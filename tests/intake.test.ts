import { describe, expect, it } from "vitest";
import { evaluateIntake } from "@/lib/intake/commands";

const input = { action: "create_job" as const, disposition: "independent" as const, expectedOutcome: "Educate founders", requestedOutputs: ["x_post" as const], sourceHandles: [], rightsAttested: false };
describe("host intake validation", () => {
  it("accepts independent work without a campaign", () => expect(evaluateIntake(input, []).missingFields).toEqual([]));
  it("requires purpose rather than campaign for independent work", () => expect(evaluateIntake({ ...input, expectedOutcome: "" }, []).missingFields).toEqual(["expectedOutcome"]));
  it("asks one focused question for ambiguous authorized targets", () => {
    const result = evaluateIntake({ ...input, disposition: "existing_plan_item", targetName: "Launch" }, [{ campaignId: "c1", itemId: "i1", name: "Launch" }, { campaignId: "c2", itemId: "i2", name: "Launch" }]);
    expect(result.missingFields).toEqual(["target"]);
    expect(result.question).toContain("c1/i1");
  });
  it("resolves exact item IDs and ignores model supplied unauthorized IDs", () => {
    const targets = [{ campaignId: "c1", itemId: "i1", name: "Launch" }];
    expect(evaluateIntake({ ...input, disposition: "existing_plan_item", targetName: "c1/i1" }, targets).target).toEqual(targets[0]);
    expect(evaluateIntake({ ...input, disposition: "existing_plan_item", targetName: "other/i1" }, targets).missingFields).toEqual(["target"]);
  });
  it("requires attachment rights and preserves selected outputs", () => {
    expect(evaluateIntake({ ...input, sourceHandles: [{ kind: "upload", attachmentId: "a" }] }, []).missingFields).toEqual(["rights"]);
    expect(evaluateIntake({ ...input, requestedOutputs: [] }, []).missingFields).toEqual(["requestedOutputs"]);
  });
  it("accepts text-only strategy and knowledge-only without production outputs", () => {
    expect(evaluateIntake({ ...input, action: "establish_strategy", requestedOutputs: [] }, []).missingFields).toEqual([]);
    expect(evaluateIntake({ ...input, disposition: "knowledge_only", requestedOutputs: [], sourceHandles: [{ kind: "web", url: "https://example.com" }] }, []).missingFields).toEqual([]);
  });
});
