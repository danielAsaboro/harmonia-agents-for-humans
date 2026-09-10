import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import { runWithTenant } from "@/lib/tenancy";
import { servicePrincipal } from "@/lib/authority";
import {
  sealDreamInput,
  reserveDream,
  persistDream,
} from "@/lib/residentAutonomy/runtime";

const tenant = {
  workspaceId: `dream-${randomUUID()}`,
  brandId: "brand-a",
  principal: servicePrincipal("test-dream-runtime"),
};
const token = "durable-claim-token";
const key = (collection: string, id: string) =>
  recordKey(`workspaces/${tenant.workspaceId}/${collection}/${id}`);
const scoped = <T>(fn: () => T) => runWithTenant(tenant, fn);
const future = () => new Date(Date.now() + 60_000).toISOString();
async function cycle(id: string, patch: Record<string, unknown> = {}) {
  await awsRepository().put(key("autonomy_cycles", id), {
    id,
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    type: "dream_cycle",
    state: "running",
    scheduledAt: new Date().toISOString(),
    timezone: "UTC",
    triggerReason: "test",
    cycleVersion: "1",
    effectBearing: false,
    armsAttempted: [],
    evidenceRefs: [],
    modelUsageIds: [],
    estimatedCostUsd: 0,
    outcome: "running",
    leaseTokenDigest: createHash("sha256").update(token).digest("hex"),
    leaseExpiresAt: future(),
    ...patch,
  });
}
async function observation(id: string, patch: Record<string, unknown> = {}) {
  await awsRepository().put(key("autonomy_observations", id), {
    id,
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    sourceRecordId: `receipt-${id}`,
    observationType: "verified_export",
    provenance: "verified_live",
    verified: true,
    authorized: true,
    observedAt: new Date().toISOString(),
    facts: { format: "short_clip" },
    ...patch,
  });
}
const output = (evidenceId: string) => ({
  safe_activity_summary: "A verified export may support a format preference.",
  reflections: [
    {
      id: "reflection-1",
      evidence_refs: [evidenceId],
      scope: "content_format",
      summary: "One verified export.",
      confidence: 0.5,
      expires_at: future(),
      expected_benefit: "Evaluate preference",
      risk_class: "low",
      estimated_cost_usd: 0,
      evaluation_criteria: "More verified receipts",
    },
  ],
  hypotheses: [],
  experiments: [],
});

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)(
  "resident lifecycle on native DynamoDB",
  () => {
    beforeEach(async () => {
      vi.stubEnv("HARMONIA_ALLOW_PAID_AWS", "true");
      vi.stubEnv("DREAM_MAX_COST_USD", "0.25");
      await awsRepository().put(recordKey(`workspaces/${tenant.workspaceId}`), {
        budget: { estimatedUsd: "0.00", reservedUsd: "0.00", limitUsd: "0.50" },
      });
    });
    it("rejects wrong claim type, stale token and expired lease", async () => {
      await cycle("wrong", { type: "heartbeat" });
      await expect(
        scoped(() => sealDreamInput("wrong", token)),
      ).rejects.toThrow();
      await cycle("stale");
      await expect(
        scoped(() => sealDreamInput("stale", "stale-token")),
      ).rejects.toThrow();
      await cycle("expired", {
        leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
      });
      await expect(
        scoped(() => sealDreamInput("expired", token)),
      ).rejects.toThrow();
    });
    it("seals immutable eligible evidence inside the brand and reserves at most once", async () => {
      await cycle("sealed");
      await observation("included");
      await observation("foreign", { brandId: "brand-b" });
      await observation("unverified", { provenance: "unverified" });
      const sealed = await scoped(() => sealDreamInput("sealed", token));
      expect(sealed).toMatchObject({ observationIds: ["included"] });
      await observation("later");
      expect(await scoped(() => sealDreamInput("sealed", token))).toEqual(
        sealed,
      );
      const reservations = await Promise.all([
        scoped(() => reserveDream("sealed", token)),
        scoped(() => reserveDream("sealed", token)),
      ]);
      expect(reservations.filter((v) => v.accepted)).toHaveLength(1);
      expect(
        (
          await awsRepository().read(
            recordKey(`workspaces/${tenant.workspaceId}`),
          )
        ).value?.budget,
      ).toMatchObject({ reservedUsd: "0.250000" });
    });
    it("rejects exhausted workspace budget without dispatching synthesis", async () => {
      await cycle("exhausted");
      await scoped(() => sealDreamInput("exhausted", token));
      await awsRepository().patch(
        recordKey(`workspaces/${tenant.workspaceId}`),
        { "budget.limitUsd": "0.10" },
      );
      expect(
        await scoped(() => reserveDream("exhausted", token)),
      ).toMatchObject({ accepted: false });
      expect(
        (await awsRepository().read(key("autonomy_dream_runs", "exhausted")))
          .value?.state,
      ).toBe("sealed");
    });
    it("rejects evidence outside sealed input, commits once, and retries missing projections after completion", async () => {
      await cycle("persist");
      await observation("persist-proof");
      await scoped(() => sealDreamInput("persist", token));
      await scoped(() => reserveDream("persist", token));
      await expect(
        scoped(() => persistDream("persist", token, output("invented"))),
      ).rejects.toThrow("dream evidence outside sealed input");
      const value = output("persist-proof");
      await scoped(() => persistDream("persist", token, value));
      const before = (
        await awsRepository().read(
          recordKey(`workspaces/${tenant.workspaceId}`),
        )
      ).value?.budget;
      const projections = await awsRepository().query(partition(`workspaces/${tenant.workspaceId}/autonomy_reflections`));
      const projection = projections.rows.find(row => row.value?.cycleId === "persist")!;
      expect(projection).toBeTruthy();
      await awsRepository().remove(projection.key);
      await awsRepository().patch(key("autonomy_cycles", "persist"), {
        state: "completed",
      });
      expect(await scoped(() => persistDream("persist", token, value))).toEqual(
        { completed: true },
      );
      expect(
        (
          await awsRepository().read(
            recordKey(`workspaces/${tenant.workspaceId}`),
          )
        ).value?.budget,
      ).toEqual(before);
      expect(
        (
          await awsRepository().read(
            projection.key,
          )
        ).present,
      ).toBe(true);
      await expect(
        scoped(() =>
          persistDream("persist", token, {
            ...value,
            safe_activity_summary: "Changed immutable result",
          }),
        ),
      ).rejects.toThrow();
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await awsRepository().removeTree(
        recordKey(`workspaces/${tenant.workspaceId}`),
      );
    });
  },
);
