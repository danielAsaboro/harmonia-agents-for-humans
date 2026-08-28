import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/firestore";
import { applyNudge, proposeNudge, redoJobStage } from "@/lib/steering/repository";
import { runWithTenant } from "@/lib/tenancy";
import { servicePrincipal } from "@/lib/authority";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const scope = { workspaceId: `steering-${Date.now()}`, brandId: "brand-1", principal: servicePrincipal("steering-test") };
const root = `workspaces/${scope.workspaceId}`;

describe.skipIf(!emulator)("durable steering transactions", () => {
  const jobId = "job-safe";

  it("atomically rewinds state and creates an epoch-specific pending outbox", async () => {
    await db().doc(`${root}/jobs/${jobId}`).set({
      id: jobId, workspaceId: scope.workspaceId, brandId: scope.brandId,
      createdByUserId: "operator-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "running", stage: "awaiting_approval", controlEpoch: 2, controlState: "running",
      config: { platforms: [] }, actions: [{ id: "a1", state: "planned", approvalState: "approved" }],
    });
    const dispatch = await runWithTenant(scope, () => redoJobStage(jobId, 2, "draft", "REDO draft"));
    const [job, outbox] = await Promise.all([
      db().doc(`${root}/jobs/${jobId}`).get(), db().doc(`${root}/stage_outbox/${dispatch.outboxId}`).get(),
    ]);
    expect(dispatch.controlEpoch).toBe(3);
    expect(job.data()).toMatchObject({ stage: "draft", controlEpoch: 3, status: "running" });
    expect((job.get("actions") as Array<{ approvalState: string }>)[0].approvalState).toBe("pending");
    expect(outbox.data()).toMatchObject({ jobId, stage: "draft", attempt: 3, state: "pending" });
    await expect(runWithTenant(scope, () => redoJobStage(jobId, 2, "draft", "REDO draft"))).rejects.toThrow("stale steering epoch");
  });

  it("applies a nudge through a new durable outbox", async () => {
    const proposed = await runWithTenant(scope, () => proposeNudge(jobId, { scope: "current_stage", instruction: "Use a more technical opening" }));
    const dispatch = await runWithTenant(scope, () => applyNudge(jobId, proposed.nudge.id, proposed.impact.digest));
    const [outbox, job] = await Promise.all([
      db().doc(`${root}/stage_outbox/${dispatch.outboxId}`).get(), db().doc(`${root}/jobs/${jobId}`).get(),
    ]);
    expect(outbox.data()).toMatchObject({ stage: "draft", attempt: 4, state: "pending" });
    expect(job.get("steeringInstructions")).toHaveLength(1);
    expect(dispatch.controlEpoch).toBe(4);
  });

  it("rejects rewinds that would cross an executed effect", async () => {
    const unsafe = "job-unsafe";
    await db().doc(`${root}/jobs/${unsafe}`).set({
      id: unsafe, workspaceId: scope.workspaceId, brandId: scope.brandId,
      createdByUserId: "operator-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: "complete", stage: "complete", controlEpoch: 0, config: { platforms: [] },
      actions: [{ id: "published", state: "executed", approvalState: "approved" }],
    });
    await expect(runWithTenant(scope, () => redoJobStage(unsafe, 0, "draft", "REDO draft")))
      .rejects.toThrow("cannot redo across executed external effects");
  });

  afterAll(async () => { if (emulator) await db().recursiveDelete(db().doc(root)); });
});
