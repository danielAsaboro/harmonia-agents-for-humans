import { describe, expect, it } from "vitest";
import { applyPolicy, approvedPendingExecution, evaluateActionPolicy, validateDraftText } from "@/lib/policy";

describe("evaluateActionPolicy", () => {
  it.each([
    ["publish_linkedin_post", "LinkedIn"],
  ] as const)("requires approval for %s", (type, provider) => {
    expect(evaluateActionPolicy(type, {})).toEqual({
      risk: "high",
      requiresApproval: true,
      reason: `posts live content to ${provider}`,
    });
  });

  it("always gates X publishing behind approval", () => {
    const d = evaluateActionPolicy("publish_x_post", { text: "hello" });
    expect(d.requiresApproval).toBe(true);
    expect(d.risk).toBe("high");
  });

  it("blocks over-limit drafts from executing", () => {
    const d = evaluateActionPolicy("publish_x_post", { text: "x".repeat(300) });
    expect(d.reason).toContain("blocked");
    const actions = applyPolicy([{ id: "1", jobId: "j", type: "publish_x_post", title: "t", description: "", payload: { type: "publish_x_post", text: "x".repeat(300) } }]);
    expect(approvedPendingExecution(actions)).toHaveLength(0);
  });

  it("allows content-pack export without approval", () => {
    const d = evaluateActionPolicy("export_content_artifact", {});
    expect(d.risk).toBe("low");
    expect(d.requiresApproval).toBe(false);
  });

  it("always gates Veo and Lyria generation behind operator approval", () => {
    for (const type of ["generate_veo_broll", "generate_lyria_soundtrack"] as const) {
      const decision = evaluateActionPolicy(type, { prompt: "launch energy" });
      expect(decision.risk).toBe("medium");
      expect(decision.requiresApproval).toBe(true);
      expect(decision.reason).toContain("paid generative media");
    }
  });
});

describe("validateDraftText", () => {
  it("enforces the 280-char X limit", () => {
    expect(validateDraftText("x", "y".repeat(281)).valid).toBe(false);
    expect(validateDraftText("x", "y".repeat(280)).valid).toBe(true);
    expect(validateDraftText("tiktok", "hi").valid).toBe(false);
  });
});
