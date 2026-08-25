import { afterAll, describe, expect, it } from "vitest";

import { servicePrincipal } from "@/lib/authority";
import { createEffectCommand, effectCommandDigest, type EffectCommandInput } from "@/lib/effectCommands";
import { claimCommandEffect, createCommand, finalizeCommandReceipt, getCommand } from "@/lib/effectCommandStore";
import { db, getJob, listReceipts } from "@/lib/firestore";
import { runWithTenant } from "@/lib/tenancy";
import type { PlannedAction, Receipt } from "@/lib/types";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const scope = { workspaceId: "command-test", brandId: "brand-test", principal: servicePrincipal("command-integration") };
const jobId = `command-${Date.now()}`;
const action: PlannedAction = {
  id: "action-1", jobId, type: "publish_x_post", title: "Publish", description: "",
  risk: "high", requiresApproval: true, approvalState: "approved", payload: { text: "Launch" }, state: "planned",
};
const draft: EffectCommandInput = {
  id: "command-1", workspaceId: scope.workspaceId, brandId: scope.brandId,
  sourceKind: "job_action", sourceId: action.id, jobId, actionId: action.id,
  actionType: action.type, payload: action.payload,
  authorization: { kind: "approval", approvalId: action.id, approvedPayloadDigest: "pending" },
};
const command = createEffectCommand({ ...draft, authorization: { kind: "approval", approvalId: action.id, approvedPayloadDigest: effectCommandDigest(draft) } });
const jobPath = `workspaces/${scope.workspaceId}/jobs/${jobId}`;

describe.skipIf(!emulator)("effect command Firestore aggregate", () => {
  it("grants one owner and atomically finalizes command, claim, receipt, and action", async () => {
    await db().doc(jobPath).set({
      workspaceId: scope.workspaceId, brandId: scope.brandId, createdByUserId: "operator-test",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running",
      stage: "publish", config: { platforms: ["x"] }, actions: [action],
    });
    await runWithTenant(scope, () => createCommand(command));
    const owner = { operationId: `${jobId}:publish:${action.id}`, traceId: "a".repeat(32) };
    const outcomes = await runWithTenant(scope, () => Promise.all([
      claimCommandEffect(command.id, { ...owner, claimToken: "owner-a" }),
      claimCommandEffect(command.id, { ...owner, claimToken: "owner-b" }),
    ]));
    expect(outcomes.map((value) => value.outcome).sort()).toEqual(["execute", "in_progress"]);
    const winner = outcomes.find((value) => value.outcome === "execute")!;
    const receipt: Receipt = {
      id: "receipt-1", jobId, actionId: action.id, actionType: action.type,
      idempotencyKey: command.payloadDigest, performedAt: new Date().toISOString(), outcome: "applied",
      detail: {}, operationId: owner.operationId, traceId: owner.traceId,
    };
    await runWithTenant(scope, () => finalizeCommandReceipt(command.id, receipt, winner.claim.claimToken));
    const aggregate = await runWithTenant(scope, async () => ({
      command: await getCommand(command.id), job: await getJob(jobId), receipts: await listReceipts(jobId),
    }));
    expect(aggregate.command?.state).toBe("applied");
    expect(aggregate.job.actions[0].state).toBe("executed");
    expect(aggregate.receipts).toHaveLength(1);
  });

  afterAll(async () => {
    if (emulator) await db().recursiveDelete(db().doc(`workspaces/${scope.workspaceId}`));
  });
});
