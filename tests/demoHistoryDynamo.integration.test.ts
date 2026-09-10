import { recordKey, awsRepository, partition, where } from "../src/lib/dynamo";
import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/repository";
import {
  applyDemoHistory,
  discoverDemoHistory,
  verifyDemoHistory,
} from "@/lib/demoHistoryStore";

const emulator = process.env.AWS_LOCAL_ENDPOINT;
const workspaceId = `demo-history-test-${Date.now()}`;
const brandId = "brand-test";
const datasetId = "aug27";
const manifestPath = `workspaces/${workspaceId}/brands/${brandId}/demo_datasets/${datasetId}`;

describe.skipIf(!emulator)("demo history DynamoDB copy", () => {
  it("copies job history, preserves sources, and quarantines executable records", async () => {
    const sourceJob = {
      id: "j1",
      workspaceId,
      brandId,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      status: "running",
      stage: "draft",
    };
    await awsRepository().put(recordKey(`workspaces/${workspaceId}`), { defaultBrandId: brandId });
    await awsRepository().put(recordKey(`workspaces/${workspaceId}/brands/${brandId}`), { id: brandId, workspaceId });
    await awsRepository().put(recordKey(`workspaces/${workspaceId}/jobs/j1`), sourceJob);
    await awsRepository().put(recordKey(`workspaces/${workspaceId}/jobs/j1/stage_attempts/a1`), {
      jobId: "j1",
      createdAt: "2026-08-30T01:00:00.000Z",
    });
    await awsRepository().put(recordKey(`workspaces/${workspaceId}/jobs/j1/stage_executions/e1`), {
      jobId: "j1",
      state: "claimed",
      leaseExpiresAt: "2026-08-30T01:30:00.000Z",
    });
    await awsRepository().put(recordKey(`workspaces/${workspaceId}/brands/${brandId}/production_plans/p1`), {
      id: "p1",
      jobId: "j1",
      workspaceId,
      brandId,
      state: "approved",
      createdAt: "2026-08-30T02:00:00.000Z",
    });
    await awsRepository().put(recordKey(`workspaces/${workspaceId}/brands/${brandId}/production_plans/p1/operation_claims/c1`), {
      id: "c1",
      jobId: "j1",
      state: "claimed",
      claimedAt: "2026-08-30T03:00:00.000Z",
    });
    await awsRepository().put(recordKey(`workspaces/${workspaceId}/brands/${brandId}/production_operation_outbox/o1`), {
      id: "o1",
      jobId: "j1",
      state: "pending",
      createdAt: "2026-08-30T04:00:00.000Z",
    });

    const sourceBefore = (await awsRepository().read(recordKey(`workspaces/${workspaceId}/jobs/j1`))).value;
    const discoveryInput = {
      workspaceId,
      brandId,
      datasetId,
      anchor: "2026-08-27T00:00:00.000Z",
    };
    const plan = await discoverDemoHistory({ ...discoveryInput, mode: "dry-run" } as typeof discoveryInput);
    const applyPlan = await discoverDemoHistory({
      ...discoveryInput,
      mode: "apply",
      expectedDigest: plan.digest,
    } as typeof discoveryInput);

    expect(plan.sourceJobCount).toBe(1);
    expect(plan.minimumSourceTimestamp).toBe("2026-08-30T00:00:00.000Z");
    expect(plan.minimumDemoTimestamp).toBe("2026-08-27T00:00:00.000Z");
    expect(plan.unsafeLiveDestinationCount).toBe(0);
    expect(applyPlan.digest).toBe(plan.digest);

    const manifest = await applyDemoHistory(applyPlan, plan.digest);
    const demoJobs = await awsRepository().query(where(partition(`workspaces/${workspaceId}/jobs`), "demoProvenance.datasetId", "==", datasetId));
    expect(demoJobs.size).toBe(1);
    expect(demoJobs.rows[0].value).toMatchObject({
      status: "complete",
      stage: "complete",
      createdAt: "2026-08-27T00:00:00.000Z",
      demoProvenance: {
        kind: "teaching_demo",
        datasetId,
        originalStatus: "running",
        originalStage: "draft",
      },
    });
    expect((await awsRepository().read(recordKey(partition(demoJobs.rows[0].key.path + "/" + "stage_attempts").partition + "/" + "a1"))).value).toMatchObject({
      jobId: demoJobs.rows[0].id,
      createdAt: "2026-08-27T01:00:00.000Z",
    });
    expect((await awsRepository().query(where(partition(`workspaces/${workspaceId}/brands/${brandId}/production_plans`), "demoProvenance.datasetId", "==", datasetId))).size).toBe(1);
    expect((await awsRepository().query(where(partition(`workspaces/${workspaceId}/brands/${brandId}/production_operation_outbox`), "demoProvenance.datasetId", "==", datasetId))).empty).toBe(true);
    expect((await awsRepository().query(where(partition(`${manifestPath}/records`), "quarantined", "==", true))).size).toBe(3);
    expect((await awsRepository().query(partition(demoJobs.rows[0].key.path + "/" + "stage_executions"))).empty).toBe(true);
    expect((await awsRepository().read(recordKey(`workspaces/${workspaceId}/jobs/j1`))).value).toEqual(sourceBefore);
    expect(manifest.minimumDemoTimestamp).toBe("2026-08-27T00:00:00.000Z");

    await expect(applyDemoHistory(plan, plan.digest)).rejects.toThrow("demo dataset already exists");
    await expect(applyDemoHistory(plan, "0".repeat(64))).rejects.toThrow("demo history plan digest mismatch");

    await expect(verifyDemoHistory(manifestPath)).resolves.toMatchObject({
      sourceUnchanged: true,
      minimumTimestampMatchesAnchor: true,
      relativeIntervalsPreserved: true,
      executableDestinationCount: 0,
      manifestDigestMatches: true,
    });
  });

  afterAll(async () => {
    if (emulator) await db().removeTree(recordKey(`workspaces/${workspaceId}`));
  });
});
