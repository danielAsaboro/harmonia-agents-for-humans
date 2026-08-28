import { afterAll, describe, expect, it } from "vitest";

import { firebasePrincipal } from "@/lib/authority";
import { createJob, db, getJob } from "@/lib/firestore";
import { createCommandEnvelope } from "@/lib/operations/commands";
import { JobControlCommandStore } from "@/lib/operations/commandStore";
import { runWithTenant } from "@/lib/tenancy";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const workspaceId = `job-control-test-${Date.now()}`;
const scope = {
  workspaceId,
  brandId: "brand-test",
  principal: firebasePrincipal({ subjectId: "user-test", workspaceRole: "owner", authenticationId: "firebase-test" }),
};

describe.skipIf(!emulator)("job control Firestore transaction", () => {
  it("records one receipt and returns it for an identical command retry", async () => {
    const job = await runWithTenant(scope, () => createJob({ brief: "A sufficiently detailed integration test brief.", platforms: ["x"] }, "understand"));
    const command = createCommandEnvelope({
      commandId: "pause-command-1",
      jobId: job.id,
      action: "pause",
      expectedControlVersion: 0,
      actor: { actorType: "firebase_operator", subjectId: "user-test", authenticationId: "firebase-test" },
      receivedAt: "2026-08-31T00:00:00.000Z",
    });
    const store = new JobControlCommandStore(db());
    const first = await runWithTenant(scope, () => store.record(command));
    const duplicate = await runWithTenant(scope, () => store.record(command));
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ accepted: true, resultingControlVersion: 1, resultingDesiredState: "pause_requested" });
    expect(await runWithTenant(scope, () => getJob(job.id))).toMatchObject({ desiredState: "pause_requested", controlVersion: 1 });

    const conflicting = createCommandEnvelope({ ...command, action: "cancel" });
    await expect(runWithTenant(scope, () => store.record(conflicting))).rejects.toThrow("different payload");
  });

  afterAll(async () => {
    if (emulator) await db().recursiveDelete(db().doc(`workspaces/${workspaceId}`));
  });
});
