import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { servicePrincipal } from "@/lib/authority";
import {
  claimEffect,
  db,
  finalizeEffectReceipt,
  getJob,
  listReceipts,
  saveContentPack,
} from "@/lib/firestore";
import { runWithTenant } from "@/lib/tenancy";
import type { PlannedAction, Receipt } from "@/lib/types";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const jobId = `tenant-collision-${Date.now()}`;
const actionId = "export-pack";
const idempotencyKey = "a".repeat(64);
const receiptId = "shared-receipt-id";

function scope(workspaceId: string, brandId: string) {
  return { workspaceId, brandId, principal: servicePrincipal(`service-${workspaceId}`) };
}

const tenantA = scope("isolation-workspace-a", "brand-a");
const tenantB = scope("isolation-workspace-b", "brand-b");
const tenantC = scope("isolation-workspace-c", "brand-c");

function action(workspaceLabel: string): PlannedAction {
  return {
    id: actionId,
    jobId,
    type: "export_content_pack",
    title: `Export ${workspaceLabel}`,
    description: "Tenant-scoped deterministic export",
    risk: "low",
    requiresApproval: false,
    approvalState: "not_required",
    payload: { type: "export_content_pack", workspaceLabel },
    state: "planned",
  };
}

async function seed(tenant: typeof tenantA, workspaceLabel: string) {
  const plannedAction = action(workspaceLabel);
  await db().doc(`workspaces/${tenant.workspaceId}/jobs/${jobId}`).set({
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    createdByUserId: `operator-${workspaceLabel}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    stage: "publish",
    config: { platforms: [], brief: workspaceLabel },
    actions: [plannedAction],
  });
  return plannedAction;
}

describe.skipIf(!emulator)("tenant effect isolation", () => {
  it("isolates colliding job, action, claim, receipt, and artifact identifiers by workspace", async () => {
    const [actionA, actionB] = await Promise.all([
      seed(tenantA, "tenant-a"),
      seed(tenantB, "tenant-b"),
    ]);
    const markdownA = "# Tenant A content pack";
    const markdownB = "# Tenant B content pack";
    const digestA = createHash("sha256").update(markdownA).digest("hex");
    const digestB = createHash("sha256").update(markdownB).digest("hex");
    await Promise.all([
      runWithTenant(tenantA, () => saveContentPack(jobId, markdownA, digestA)),
      runWithTenant(tenantB, () => saveContentPack(jobId, markdownB, digestB)),
    ]);

    const [claimA, claimB] = await Promise.all([
      runWithTenant(tenantA, () => claimEffect({
        jobId, actionId, actionType: actionA.type, idempotencyKey,
        operationId: `${jobId}:tenant-a:effect`, traceId: "1".repeat(32), claimToken: "owner-a",
      })),
      runWithTenant(tenantB, () => claimEffect({
        jobId, actionId, actionType: actionB.type, idempotencyKey,
        operationId: `${jobId}:tenant-b:effect`, traceId: "2".repeat(32), claimToken: "owner-b",
      })),
    ]);
    expect(claimA.outcome).toBe("execute");
    expect(claimB.outcome).toBe("execute");

    const receiptA: Receipt = {
      id: receiptId, jobId, actionId, actionType: actionA.type, idempotencyKey,
      performedAt: new Date().toISOString(), outcome: "applied",
      artifact: { kind: "firestore_doc", url: "local://tenant-a", fetchedAt: new Date().toISOString(), digest: digestA },
      detail: { digest: digestA }, operationId: `${jobId}:tenant-a:effect`, traceId: "1".repeat(32),
    };
    const receiptB: Receipt = {
      ...receiptA,
      artifact: { kind: "firestore_doc", url: "local://tenant-b", fetchedAt: new Date().toISOString(), digest: digestB },
      detail: { digest: digestB }, operationId: `${jobId}:tenant-b:effect`, traceId: "2".repeat(32),
    };
    await Promise.all([
      runWithTenant(tenantA, () => finalizeEffectReceipt(receiptA, "owner-a")),
      runWithTenant(tenantB, () => finalizeEffectReceipt(receiptB, "owner-b")),
    ]);

    const [jobA, jobB, receiptsA, receiptsB] = await Promise.all([
      runWithTenant(tenantA, () => getJob(jobId)),
      runWithTenant(tenantB, () => getJob(jobId)),
      runWithTenant(tenantA, () => listReceipts(jobId)),
      runWithTenant(tenantB, () => listReceipts(jobId)),
    ]);
    expect(jobA.contentPack).toMatchObject({ markdown: markdownA, digest: digestA });
    expect(jobB.contentPack).toMatchObject({ markdown: markdownB, digest: digestB });
    expect(receiptsA).toEqual([expect.objectContaining({ id: receiptId, detail: { digest: digestA } })]);
    expect(receiptsB).toEqual([expect.objectContaining({ id: receiptId, detail: { digest: digestB } })]);

    await expect(runWithTenant(tenantC, () => getJob(jobId))).rejects.toThrow(`job not found: ${jobId}`);
    await expect(runWithTenant(tenantC, () => claimEffect({
      jobId, actionId, actionType: actionA.type, idempotencyKey,
      operationId: `${jobId}:tenant-c:effect`, traceId: "3".repeat(32), claimToken: "owner-c",
    }))).rejects.toThrow(`job not found: ${jobId}`);
    expect(await runWithTenant(tenantC, () => listReceipts(jobId))).toEqual([]);
  });

  afterAll(async () => {
    if (!emulator) return;
    await Promise.all([
      db().recursiveDelete(db().doc(`workspaces/${tenantA.workspaceId}`)),
      db().recursiveDelete(db().doc(`workspaces/${tenantB.workspaceId}`)),
      db().recursiveDelete(db().doc(`workspaces/${tenantC.workspaceId}`)),
    ]);
  });
});
