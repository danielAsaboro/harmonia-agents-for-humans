import { recordKey, awsRepository } from "../src/lib/dynamo";
import { afterAll, describe, expect, it } from "vitest";

import { servicePrincipal } from "@/lib/authority";
import { db } from "@/lib/repository";
import { getDurableRuntimeSnapshot } from "@/lib/observability/repository";
import { runWithTenant, tenantCollectionPath } from "@/lib/tenancy";

const emulator = process.env.AWS_LOCAL_ENDPOINT;
const scope = { workspaceId: "runtime-observability-test", brandId: "brand-test", principal: servicePrincipal("runtime-observability") };
const now = "2026-08-28T12:00:00.000Z";

describe.skipIf(!emulator)("durable runtime observability snapshot", () => {
  it("reports stale leases, ambiguity, projection identity, artifacts, lag, and recovery work without payloads", async () => {
    const path = (name: string, id: string) => `${tenantCollectionPath(scope, name)}/${id}`;
    await Promise.all([
      awsRepository().put(recordKey(path("operations", "job:job-1:stage:draft")), { workspaceId: scope.workspaceId, brandId: scope.brandId, state: "claimed", leaseExpiresAt: "2026-08-28T11:59:00.000Z" }),
      awsRepository().put(recordKey(path("event_inbox", "inbox-1")), { workspaceId: scope.workspaceId, brandId: scope.brandId, state: "processing", claimUntil: "2026-08-28T11:59:00.000Z", receivedAt: "2026-08-28T11:58:00.000Z" }),
      awsRepository().put(recordKey(path("stage_outbox", "outbox-1")), { workspaceId: scope.workspaceId, brandId: scope.brandId, state: "claimed", claimUntil: "2026-08-28T11:59:00.000Z", createdAt: "2026-08-28T11:57:00.000Z" }),
      awsRepository().put(recordKey(path("effect_commands", "command-1")), { workspaceId: scope.workspaceId, brandId: scope.brandId, jobId: "job-1", state: "unknown", operationId: "job:job-1:effect:command-1", operationEpoch: 3, unknownReason: "provider response lost", dispatchedAt: "2026-08-28T11:55:00.000Z", payload: { private: "must not surface" } }),
      awsRepository().put(recordKey(path("context_projections", "projection-1")), { workspaceId: scope.workspaceId, brandId: scope.brandId, compilerVersion: "harmonia-context/v1", manifestDigest: "a".repeat(64), createdAt: "2026-08-28T11:50:00.000Z" }),
      awsRepository().put(recordKey(path("artifacts", "artifact-ready")), { workspaceId: scope.workspaceId, brandId: scope.brandId, state: "ready" }),
      awsRepository().put(recordKey(path("artifacts", "artifact-failed")), { workspaceId: scope.workspaceId, brandId: scope.brandId, state: "failed" }),
      awsRepository().put(recordKey(path("recovery_work", "recovery-1")), { workspaceId: scope.workspaceId, brandId: scope.brandId, state: "pending", action: "reconcile_effect", createdAt: "2026-08-28T11:59:30.000Z" }),
    ]);
    const snapshot = await runWithTenant(scope, () => getDurableRuntimeSnapshot(now));
    expect(snapshot).toMatchObject({
      staleLeases: { operations: 1, inbox: 1, outbox: 1 },
      inboxLagSeconds: 120, outboxLagSeconds: 180,
      unknownEffects: [{ commandId: "command-1", epoch: 3, reason: "provider response lost" }],
      projection: { count: 1, compilerVersion: "harmonia-context/v1", manifestDigest: "a".repeat(64) },
      artifacts: { ready: 1, failed: 1, writing: 0 }, recovery: { pending: 1 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("must not surface");
  });

  afterAll(async () => {
    if (emulator) await db().removeTree(recordKey(`workspaces/${scope.workspaceId}`));
  });
});
