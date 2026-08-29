import { afterAll, describe, expect, it } from "vitest";

import { servicePrincipal } from "@/lib/authority";
import {
  claimStageOutbox,
  createJob,
  db,
  finalizeStageOutboxPublish,
  listDispatchableStageOutbox,
} from "@/lib/firestore";
import { runWithTenant } from "@/lib/tenancy";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const scope = {
  workspaceId: "stage-outbox-test",
  brandId: "brand-test",
  principal: servicePrincipal("stage-outbox-integration"),
};

describe.skipIf(!emulator)("stage outbox Firestore transaction", () => {
  it("omits undefined optional job configuration before persistence", async () => {
    const job = await runWithTenant(scope, () => createJob({
      sourceManifestId: "manifest-optional-config",
      desiredOutputs: ["x_post"],
      allowedOutputs: ["x_post"],
      platforms: ["x"],
      strategyContext: undefined,
      analysisResearchRequest: undefined,
    }, "collect_sources"));

    const snapshot = await db().doc(`workspaces/${scope.workspaceId}/jobs/${job.id}`).get();
    expect(snapshot.get("config")).toEqual({
      sourceManifestId: "manifest-optional-config",
      desiredOutputs: ["x_post"],
      allowedOutputs: ["x_post"],
      platforms: ["x"],
    });
  });

  it("atomically creates the initial trigger and grants one concurrent publisher", async () => {
    const job = await runWithTenant(scope, () => createJob({ sourceManifestId: "manifest-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, "understand"));
    const [record] = await runWithTenant(scope, () => listDispatchableStageOutbox());
    expect(record).toMatchObject({ jobId: job.id, stage: "understand", state: "pending" });

    const outcomes = await runWithTenant(scope, () => Promise.all([
      claimStageOutbox(record.id, "owner-a"),
      claimStageOutbox(record.id, "owner-b"),
    ]));
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["in_progress", "publish"]);

    const winnerIndex = outcomes.findIndex((result) => result.outcome === "publish");
    const winnerDigest = winnerIndex === 0 ? "owner-a" : "owner-b";
    await runWithTenant(scope, () => finalizeStageOutboxPublish(record.id, winnerDigest, "pubsub-message-1"));
    const snapshot = await db().doc(`workspaces/${scope.workspaceId}/stage_outbox/${record.id}`).get();
    expect(snapshot.data()).toMatchObject({ state: "published", pubsubMessageId: "pubsub-message-1" });
  });

  afterAll(async () => {
    if (emulator) await db().recursiveDelete(db().doc(`workspaces/${scope.workspaceId}`));
  });
});
