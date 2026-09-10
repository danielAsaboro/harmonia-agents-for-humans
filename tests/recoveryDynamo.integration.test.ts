import { recordKey, field, awsRepository, partition } from "../src/lib/dynamo";
import { afterAll, describe, expect, it } from "vitest";

import { servicePrincipal } from "@/lib/authority";
import { createArtifactRecord } from "@/lib/artifacts";
import { createEffectCommand, effectCommandDigest, markEffectDispatched, markEffectObserved, type EffectCommandInput } from "@/lib/effectCommands";
import { db } from "@/lib/repository";
import { claimOperation, createOperation } from "@/lib/operations";
import { runRecovery } from "@/lib/recoveryStore";
import { runWithTenant, tenantCollectionPath } from "@/lib/tenancy";

const emulator = process.env.AWS_LOCAL_ENDPOINT;
const scope = { workspaceId: "recovery-test", brandId: "brand-test", principal: servicePrincipal("recovery-integration") };
const expiredAt = "2026-08-28T10:00:00.000Z";

describe.skipIf(!emulator)("recovery DynamoDB controller", () => {
  it("atomically requeues safe work, quarantines ambiguous work, and emits bounded recovery records", async () => {
    const operationCollection = tenantCollectionPath(scope, "operations");
    const safe = claimOperation(createOperation({
      id: "job:job-safe:stage:draft", workspaceId: scope.workspaceId, brandId: scope.brandId,
      jobId: "job-safe", kind: "stage", goal: { type: "draft", version: 1, digest: "a".repeat(64), acceptance: ["persist"] },
      correlationId: "job:job-safe", replayPolicy: "safe", maxAttempts: 3, now: "2026-08-28T09:00:00.000Z",
    }), { ownerId: "dead", ownerTokenDigest: "b".repeat(64), now: "2026-08-28T09:01:00.000Z", leaseExpiresAt: expiredAt }).operation;
    const reconcile = claimOperation(createOperation({
      id: "job:job-effect:effect:command-old", workspaceId: scope.workspaceId, brandId: scope.brandId,
      jobId: "job-effect", kind: "effect", goal: { type: "publish", version: 1, digest: "c".repeat(64), acceptance: ["receipt"] },
      correlationId: "job:job-effect", replayPolicy: "reconcile", maxAttempts: 3, now: "2026-08-28T09:00:00.000Z",
    }), { ownerId: "dead", ownerTokenDigest: "d".repeat(64), now: "2026-08-28T09:01:00.000Z", leaseExpiresAt: expiredAt }).operation;
    await Promise.all([
      awsRepository().put(recordKey(`${operationCollection}/${safe.id}`), safe),
      awsRepository().put(recordKey(`${operationCollection}/${reconcile.id}`), reconcile),
      awsRepository().put(recordKey(`${tenantCollectionPath(scope, "event_inbox")}/inbox-1`), {
        id: "inbox-1", workspaceId: scope.workspaceId, brandId: scope.brandId, jobId: "job-inbox",
        state: "processing", replayPolicy: "safe", deliveryAttempts: 1, claimUntil: expiredAt,
        sourceEventId: "stage-outbox:source-outbox", operationId: safe.id,
      }),
      awsRepository().put(recordKey(`${tenantCollectionPath(scope, "stage_outbox")}/source-outbox`), {
        id: "source-outbox", workspaceId: scope.workspaceId, brandId: scope.brandId, jobId: "job-inbox",
        state: "published", publishAttempt: 1, operationId: safe.id,
        sourceEventId: "stage-outbox:source-outbox", transportMessageId: "lost-message",
      }),
      awsRepository().put(recordKey(`${tenantCollectionPath(scope, "stage_outbox")}/outbox-1`), {
        id: "outbox-1", workspaceId: scope.workspaceId, brandId: scope.brandId, jobId: "job-outbox",
        state: "claimed", publishAttempt: 1, claimUntil: expiredAt, operationId: "job:job-outbox:stage:draft",
      }),
    ]);

    const draft: EffectCommandInput = {
      id: "command-observed", workspaceId: scope.workspaceId, brandId: scope.brandId,
      sourceKind: "job_action", sourceId: "action-1", jobId: "job-observed", actionId: "action-1",
      actionType: "publish_x_post", payload: { text: "Launch" },
      authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: "pending" },
      now: "2026-08-28T09:00:00.000Z",
    };
    const prepared = createEffectCommand({ ...draft, authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: effectCommandDigest(draft) } });
    const dispatched = markEffectDispatched(prepared, {
      operationId: "job:job-observed:effect:command-observed", operationEpoch: 1, attempt: 1, now: "2026-08-28T09:01:00.000Z",
    });
    const observed = markEffectObserved(dispatched, {
      operationId: dispatched.operationId!, operationEpoch: 1, outcome: "applied", detail: { id: "post-1" }, now: "2026-08-28T09:02:00.000Z",
    });
    const artifact = {
      ...createArtifactRecord({
        id: "018f47a2-4f40-7b1f-b19f-8f6b916b7d77", workspaceId: scope.workspaceId, brandId: scope.brandId,
        jobId: "job-artifact", operationId: safe.id, uri: "memory://artifact", bytes: Buffer.from("data"),
        contentType: "text/plain", trust: "system", producer: { kind: "runtime", id: "test", version: "1" },
        retentionClass: "audit", now: "2026-08-28T09:00:00.000Z",
      }), state: "failed" as const, failureReason: "write interrupted",
    };
    await Promise.all([
      awsRepository().put(recordKey(`${tenantCollectionPath(scope, "effect_commands")}/${observed.id}`), observed),
      awsRepository().put(recordKey(`${tenantCollectionPath(scope, "artifacts")}/${artifact.id}`), artifact),
      awsRepository().put(recordKey(`${tenantCollectionPath(scope, "jobs")}/job-receipt`), {
        id: "job-receipt", workspaceId: scope.workspaceId, brandId: scope.brandId,
        stage: "verify", verifications: [],
      }),
      awsRepository().put(recordKey(`${tenantCollectionPath(scope, "jobs")}/job-receipt/receipts/receipt-1`), {
        id: "receipt-1", jobId: "job-receipt", operationId: "operation-receipt-1",
        status: "applied", createdAt: "2026-08-28T09:03:00.000Z",
      }),
    ]);

    const result = await runWithTenant(scope, () => runRecovery({
      limit: 20, deadlineSeconds: 15, maxRetries: 3, maxCostUsd: "1.000000",
    }, db()));
    expect(result.actions.map((item) => item.action)).toEqual(expect.arrayContaining([
      "replay_operation", "reconcile_operation", "requeue_event", "requeue_outbox",
      "finalize_observed_effect", "blocked_artifact", "enqueue_verification",
    ]));
    expect(result.actions.every((item) => item.emitted)).toBe(true);
    const [safeAfter, reconcileAfter, inboxAfter, outboxAfter, sourceOutboxAfter, recoveryWork] = await Promise.all([
      awsRepository().read(recordKey(`${operationCollection}/${safe.id}`)),
      awsRepository().read(recordKey(`${operationCollection}/${reconcile.id}`)),
      awsRepository().read(recordKey(`${tenantCollectionPath(scope, "event_inbox")}/inbox-1`)),
      awsRepository().read(recordKey(`${tenantCollectionPath(scope, "stage_outbox")}/outbox-1`)),
      awsRepository().read(recordKey(`${tenantCollectionPath(scope, "stage_outbox")}/source-outbox`)),
      awsRepository().query(partition(tenantCollectionPath(scope, "recovery_work"))),
    ]);
    expect(field(safeAfter.value, "state")).toBe("waiting");
    expect(field(reconcileAfter.value, "state")).toBe("unknown");
    expect(field(inboxAfter.value, "state")).toBe("accepted");
    expect(field(outboxAfter.value, "state")).toBe("pending");
    expect(field(sourceOutboxAfter.value, "state")).toBe("pending");
    expect(field(sourceOutboxAfter.value, "transportMessageId")).toBeUndefined();
    expect(recoveryWork.size).toBe(result.actions.length);
    const replay = await runWithTenant(scope, () => runRecovery({
      limit: 20, deadlineSeconds: 15, maxRetries: 3, maxCostUsd: "1.000000",
    }, db()));
    expect(replay.actions).toHaveLength(3);
    expect(replay.actions.every((item) => !item.emitted)).toBe(true);

    const secondClaim = claimOperation(safeAfter.value as unknown as typeof safe, {
      ownerId: "replacement-worker", ownerTokenDigest: "e".repeat(64),
      now: "2026-08-28T10:01:00.000Z", leaseExpiresAt: "2026-08-28T10:02:00.000Z",
    }).operation;
    await awsRepository().put(safeAfter.key, secondClaim);
    const laterCrash = await runWithTenant(scope, () => runRecovery({
      limit: 20, deadlineSeconds: 15, maxRetries: 3, maxCostUsd: "1.000000",
    }, db()));
    const laterReplay = laterCrash.actions.find((item) => item.candidateId === `operation:${safe.id}`);
    expect(laterReplay).toMatchObject({ action: "replay_operation", emitted: true });
    expect(field((await awsRepository().read(safeAfter.key)).value, "state")).toBe("waiting");
  });

  afterAll(async () => {
    if (emulator) await db().removeTree(recordKey(`workspaces/${scope.workspaceId}`));
  });
});
