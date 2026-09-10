import { awsRepository,DynamoRepository,recordKey } from "./dynamo";

import {
claimEventInbox,
completeEventInbox,
eventInboxKey,
type EventInboxClaimInput,
type EventInboxClaimResult,
type EventInboxRecord,
} from "./eventInbox";
import {
assertOperationFence,
createOperation,
finalizeOperation,
type CreateOperationInput,
type OperationRecord,
} from "./operations";
import { currentTenant,tenantCollectionPath } from "./tenancy";

const EVENT_INBOX = "event_inbox";
const OPERATIONS = "operations";

export type DurableEventClaimInput = EventInboxClaimInput & { operation: CreateOperationInput };

function assertTenant(resource: { workspaceId: string; brandId: string }): void {
  const tenant = currentTenant();
  if (resource.workspaceId !== tenant.workspaceId || resource.brandId !== tenant.brandId) {
    throw new Error("event inbox tenant mismatch");
  }
}

function assertOperationIntent(existing: OperationRecord, expected: OperationRecord): void {
  if (
    existing.id !== expected.id
    || existing.workspaceId !== expected.workspaceId
    || existing.brandId !== expected.brandId
    || existing.jobId !== expected.jobId
    || existing.kind !== expected.kind
    || existing.goal.digest !== expected.goal.digest
    || existing.correlationId !== expected.correlationId
    || existing.replayPolicy !== expected.replayPolicy
  ) {
    throw new Error("event operation identity conflict");
  }
}

export class EventInboxStore {
  constructor(private readonly database: DynamoRepository) {}

  private inboxPath(source: string, sourceEventId: string): string {
    return `${tenantCollectionPath(currentTenant(), EVENT_INBOX)}/${eventInboxKey(source, sourceEventId)}`;
  }

  private operationPath(operationId: string): string {
    if (!/^[A-Za-z0-9:_-]{1,512}$/.test(operationId)) throw new Error("invalid operation document id");
    return `${tenantCollectionPath(currentTenant(), OPERATIONS)}/${operationId}`;
  }

  async claim(input: DurableEventClaimInput): Promise<EventInboxClaimResult> {
    assertTenant(input.envelope);
    const expectedOperation = createOperation(input.operation);
    assertTenant(expectedOperation);
    if (input.envelope.operationId !== expectedOperation.id) {
      throw new Error("event operation id mismatch");
    }
    if (input.envelope.correlationId !== expectedOperation.correlationId) {
      throw new Error("event operation correlation mismatch");
    }
    if (input.replayPolicy !== expectedOperation.replayPolicy) {
      throw new Error("event operation replay policy mismatch");
    }

    const inboxRef = recordKey(this.inboxPath(input.envelope.source, input.envelope.sourceEventId));
    const operationRef = recordKey(this.operationPath(expectedOperation.id));
    return this.database.atomic(async (transaction) => {
      const [inboxSnapshot, operationSnapshot] = await Promise.all([
        transaction.read(inboxRef),
        transaction.read(operationRef),
      ]);
      const existingInbox = inboxSnapshot.present ? inboxSnapshot.value as unknown as EventInboxRecord : null;
      const result = claimEventInbox(existingInbox, input);
      if (!operationSnapshot.present) {
        transaction.insert(operationRef, expectedOperation);
      } else {
        const existingOperation = operationSnapshot.value as unknown as OperationRecord;
        assertTenant(existingOperation);
        assertOperationIntent(existingOperation, expectedOperation);
      }
      if (!inboxSnapshot.present) transaction.insert(inboxRef, result.record);
      else if (result.record !== existingInbox) transaction.put(inboxRef, result.record);
      return result;
    });
  }

  async get(source: string, sourceEventId: string): Promise<EventInboxRecord | null> {
    const snapshot = await awsRepository().read(recordKey(this.inboxPath(source, sourceEventId)));
    if (!snapshot.present) return null;
    const record = snapshot.value as unknown as EventInboxRecord;
    assertTenant(record);
    return record;
  }

  async complete(
    source: string,
    sourceEventId: string,
    input: {
      ownerTokenDigest: string;
      outcome: "completed" | "rejected";
      now: string;
      rejectionReason?: string;
      operationId: string;
      operationEpoch: number;
      operationState: "unknown" | "succeeded" | "failed" | "cancelled";
      operationReason?: string;
    },
  ): Promise<EventInboxRecord> {
    const ref = recordKey(this.inboxPath(source, sourceEventId));
    return this.database.atomic(async (transaction) => {
      const snapshot = await transaction.read(ref);
      if (!snapshot.present) throw new Error("event inbox record not found");
      const current = snapshot.value as unknown as EventInboxRecord;
      assertTenant(current);
      if (current.operationId !== input.operationId) throw new Error("event operation id mismatch");
      const operationRef = recordKey(this.operationPath(current.operationId));
      const operationSnapshot = await transaction.read(operationRef);
      if (!operationSnapshot.present) throw new Error("event operation not found");
      const operation = operationSnapshot.value as unknown as OperationRecord;
      assertTenant(operation);
      const tenant = currentTenant();
      assertOperationFence(operation, {
        operationId: input.operationId,
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        epoch: input.operationEpoch,
        now: input.now,
      });
      const completed = completeEventInbox(current, input.ownerTokenDigest, input);
      const finalizedOperation = finalizeOperation(operation, {
        epoch: input.operationEpoch,
        state: input.operationState,
        now: input.now,
        ...(input.operationReason ? { unresolvedReason: input.operationReason } : {}),
      });
      transaction.put(ref, completed);
      transaction.put(operationRef, finalizedOperation);
      return completed;
    });
  }
}
