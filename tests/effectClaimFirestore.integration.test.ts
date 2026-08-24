import { afterAll, describe, expect, it } from "vitest";

import { claimEffect, db, finalizeEffectReceipt, getEffectClaim, getJob, listReceipts } from "@/lib/firestore";
import { runWithTenant } from "@/lib/tenancy";
import type { EffectClaimInput, PlannedAction, Receipt } from "@/lib/types";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const scope = { workspaceId: "claim-test", brandId: "brand-test", userId: "service-test", role: "service" as const };
const jobId = `claim-${Date.now()}`;
const action: PlannedAction = {
  id: "action-1", jobId, type: "export_content_pack", title: "Export", description: "",
  risk: "low", requiresApproval: true, approvalState: "approved", payload: {}, state: "planned",
};
const jobPath = `workspaces/${scope.workspaceId}/jobs/${jobId}`;

describe.skipIf(!emulator)("effect claim Firestore transaction", () => {
  it("grants one concurrent owner and atomically links claim, receipt, and action", async () => {
    await db().doc(jobPath).set({
      workspaceId: scope.workspaceId, brandId: scope.brandId, createdByUserId: "operator-test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running",
      stage: "publish", config: { platforms: [] }, actions: [action],
    });
    const base: EffectClaimInput = {
      jobId, actionId: action.id, actionType: action.type, idempotencyKey: "a".repeat(64),
      operationId: `${jobId}:publish:${action.id}`, traceId: "b".repeat(32), claimToken: "owner-1",
    };
    const outcomes = await runWithTenant(scope, () => Promise.all([
      claimEffect(base),
      claimEffect({ ...base, claimToken: "owner-2" }),
    ]));
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["execute", "in_progress"]);
    const owner = outcomes.find((result) => result.outcome === "execute")!;
    const receipt: Receipt = {
      id: "receipt-1", jobId, actionId: action.id, actionType: action.type,
      idempotencyKey: base.idempotencyKey, performedAt: new Date().toISOString(), outcome: "applied",
      detail: {}, operationId: base.operationId, traceId: base.traceId,
    };
    await runWithTenant(scope, () => finalizeEffectReceipt(receipt, owner.claim.claimToken));
    const [claim, receipts, job] = await runWithTenant(scope, () => Promise.all([
      getEffectClaim(jobId, base.idempotencyKey), listReceipts(jobId), getJob(jobId),
    ]));
    expect(claim).toMatchObject({ state: "applied", receiptId: receipt.id });
    expect(receipts).toHaveLength(1);
    expect(job.actions[0]).toMatchObject({ state: "executed" });
  });

  afterAll(async () => {
    if (emulator) await db().recursiveDelete(db().doc(jobPath));
  });
});
