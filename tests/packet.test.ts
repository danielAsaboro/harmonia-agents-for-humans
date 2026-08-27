import { describe, expect, it } from "vitest";
import { assemblePacket } from "@/lib/packet";
import type { PlannedAction, PostDraft, VerificationResult } from "@/lib/types";

const config = { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", platforms: ["x"] };

const draft: PostDraft = { id: "d1", platform: "x", text: "hi", valid: true };
const publishAction: PlannedAction = {
  id: "a1", jobId: "j", type: "publish_x_post", title: "post to x", description: "",
  risk: "high", requiresApproval: true, approvalState: "approved", state: "executed",
  payload: { type: "publish_x_post", text: "hi" },
};

function verification(target: string, verified: boolean): VerificationResult {
  return {
    id: "v1", target, actionId: "a1", receiptId: "r", operationId: "j:verify:a1",
    traceId: "a".repeat(32), verified, method: "official_api_readback",
    evidence: { kind: "x_api", url: "https://x.com/i/web/status/1", fetchedAt: new Date().toISOString() },
    checkedAt: new Date().toISOString(),
  };
}

describe("assemblePacket", () => {
  it("lists pending approvals and failed verifications as unresolved gaps", () => {
    const packet = assemblePacket({
      jobId: "j", config,
      drafts: [draft],
      actions: [{ ...publishAction, approvalState: "pending" as const, state: "planned" as const }],
      receipts: [],
      verifications: [verification("tweet-1", false)],
    });
    expect(packet.unresolved.some((u) => u.includes("approval still pending"))).toBe(true);
    expect(packet.unresolved.some((u) => u.includes("not verified: tweet-1"))).toBe(true);
  });

  it("is clean when executed and verified", () => {
    const packet = assemblePacket({
      jobId: "j", config, drafts: [draft], actions: [publishAction],
      receipts: [{ id: "r", jobId: "j", actionId: "a1", idempotencyKey: "k".repeat(64), actionType: "publish_x_post", performedAt: new Date().toISOString(), outcome: "applied", operationId: "j:publish:a1", traceId: "a".repeat(32), detail: {} }],
      verifications: [verification("tweet-1", true)],
    });
    expect(packet.unresolved).toHaveLength(0);
  });

  it("requires one receipt and one verification for every executed action", () => {
    const withoutReceipt = assemblePacket({
      jobId: "j", config, drafts: [draft], actions: [publishAction], receipts: [],
      verifications: [verification("tweet-1", true)],
    });
    expect(withoutReceipt.unresolved).toContain("executed action has no receipt: post to x");

    const withoutVerification = assemblePacket({
      jobId: "j", config, drafts: [draft], actions: [publishAction],
      receipts: [{ id: "r", jobId: "j", actionId: "a1", idempotencyKey: "k".repeat(64), actionType: "publish_x_post", performedAt: new Date().toISOString(), outcome: "applied", operationId: "j:publish:a1", traceId: "a".repeat(32), detail: {} }],
      verifications: [],
    });
    expect(withoutVerification.unresolved).toContain("executed action has no verification: post to x");
  });
});
