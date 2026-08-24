import { describe, expect, it } from "vitest";

import { assertReplayApplied, replayEligibleReceipt } from "@/lib/replay";
import type { Job, PlannedAction, Receipt } from "@/lib/types";

const action: PlannedAction = {
  id: "action-1", jobId: "job-1", type: "export_content_pack", title: "Export",
  description: "", risk: "low", requiresApproval: true, approvalState: "approved",
  payload: {}, state: "executed",
};
const job = { id: "job-1", actions: [action] } as Job & { actions: PlannedAction[] };
const receipt: Receipt = {
  id: "receipt-1", jobId: "job-1", actionId: "action-1", actionType: "export_content_pack",
  idempotencyKey: "a".repeat(64), operationId: "effect-op", traceId: "b".repeat(32),
  performedAt: "2026-08-25T01:00:00Z", outcome: "applied", detail: {},
};

describe("operator replay authority", () => {
  it("allows a human member to prove only an approved executed receipt", () => {
    expect(replayEligibleReceipt(job, "action-1", [receipt], "member")).toBe(receipt);
    expect(() => replayEligibleReceipt(job, "action-1", [receipt], "service")).toThrow("human operator");
    expect(() => replayEligibleReceipt({ ...job, actions: [{ ...action, state: "planned" }] }, "action-1", [receipt], "owner")).toThrow("executed action");
    expect(() => replayEligibleReceipt(job, "action-1", [], "owner")).toThrow("applied receipt");
  });

  it("accepts only already-applied claim outcomes and never execute", () => {
    expect(assertReplayApplied({ outcome: "already_applied", receiptId: "receipt-1" })).toBe("receipt-1");
    for (const outcome of ["execute", "in_progress", "uncertain"] as const) {
      expect(() => assertReplayApplied({ outcome })).toThrow("cannot execute");
    }
  });
});
