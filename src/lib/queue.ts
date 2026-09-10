import { sendQueueMessage } from "./awsTransport";
import { getConfig } from "./config";
import { injectTraceContext } from "./telemetry";
import { eventPayloadDigest, type EventEnvelope } from "./eventInbox";
import type { StageOutboxRecord } from "./stageOutbox";
import type { ProductionOperationOutboxRecord } from "./productionPlanStore";
import type { TenantScope } from "./tenancy";
import { validateTenantScope } from "./tenancy";

export type StageMessage = EventEnvelope;

export interface BuiltStageMessage {
  data: Buffer;
  attributes: Record<string, string>;
}

export function buildStageMessage(
  scope: TenantScope,
  record: StageOutboxRecord,
): BuiltStageMessage {
  const tenant = validateTenantScope(scope);
  if (record.workspaceId !== tenant.workspaceId || record.brandId !== tenant.brandId) {
    throw new Error("stage outbox tenant mismatch");
  }
  const payload = { stage: record.stage };
  const envelope: StageMessage = {
    schemaVersion: record.schemaVersion,
    source: "stage_outbox",
    sourceEventId: record.sourceEventId,
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    jobId: record.jobId,
    eventType: "stage.requested",
    operationId: record.operationId,
    correlationId: record.correlationId,
    ...(record.causationId ? { causationId: record.causationId } : {}),
    attempt: record.attempt,
    trust: "system",
    occurredAt: record.createdAt,
    payload,
    payloadDigest: eventPayloadDigest(payload),
  };
  const attributes: Record<string, string> = {
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    jobId: record.jobId,
    stage: record.stage,
    sourceEventId: record.sourceEventId,
    operationId: record.operationId,
    schemaVersion: String(record.schemaVersion),
  };
  injectTraceContext(attributes);
  return {
    data: Buffer.from(JSON.stringify(envelope)),
    attributes,
  };
}

export async function publishStage(
  scope: TenantScope,
  record: StageOutboxRecord,
): Promise<string> {
  return sendQueueMessage(getConfig().SQS_STAGE_QUEUE_URL, buildStageMessage(scope, record));
}

export async function publishProductionOperation(
  scope: TenantScope,
  record: ProductionOperationOutboxRecord,
): Promise<string> {
  return sendQueueMessage(getConfig().SQS_PRODUCTION_QUEUE_URL, buildProductionMessage(scope, record));
}

export function buildProductionMessage(
  scope: TenantScope,
  record: ProductionOperationOutboxRecord,
): BuiltStageMessage {
  const tenant = validateTenantScope(scope);
  if (record.workspaceId !== tenant.workspaceId || record.brandId !== tenant.brandId) {
    throw new Error("production outbox tenant mismatch");
  }
  const payload = {
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    planId: record.planId,
    planRevision: record.planRevision,
    planDigest: record.planDigest,
    operationId: record.operationId,
    internalRun: record.internalRun,
  };
  const attributes: Record<string, string> = {
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    planId: record.planId,
    planRevision: String(record.planRevision),
    planDigest: record.planDigest,
    operationId: record.operationId,
    internalRun: String(record.internalRun),
    outboxId: record.id,
  };
  injectTraceContext(attributes);
  return {
    data: Buffer.from(JSON.stringify(payload)),
    attributes,
  };
}
