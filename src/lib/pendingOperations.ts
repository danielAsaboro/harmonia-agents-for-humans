import { awsRepository,partition,recordKey } from "./dynamo";
import { newId } from "./idempotency";
import { db } from "./repository";
import { assertResourceWorkspace,currentTenant,tenantCollectionPath,tenantSubjectId } from "./tenancy";

export type PendingOperationDecision = "approved" | "rejected";
export type PendingOperationState = "pending" | "processing" | PendingOperationDecision | "failed" | "expired";
export type PendingOperationHandler = "decide_job_action" | "decide_strategy" | "decide_production_plan" | "publish_preview" | "export_content_artifact" | "generate_image" | "render_clip" | "render_reel" | "publish_x_post" | "publish_x_thread" | "publish_linkedin_post";

const REGISTERED_HANDLERS = new Set<PendingOperationHandler>([
  "decide_job_action",
  "decide_strategy",
  "decide_production_plan",
  "publish_preview",
  "export_content_artifact",
  "generate_image",
  "render_clip",
  "render_reel",
  "publish_x_post",
  "publish_x_thread",
  "publish_linkedin_post",
]);

export interface PendingOperation {
  id: string;
  workspaceId: string;
  brandId: string;
  createdByUserId: string;
  handler: string;
  title: string;
  description?: string;
  risk: "low" | "material" | "high";
  arguments: Record<string, unknown>;
  state: PendingOperationState;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedByUserId?: string;
  pendingDecision?: PendingOperationDecision;
  decisionLeaseExpiresAt?: string;
  failureReason?: string;
}

function collection() {
  return partition(tenantCollectionPath(currentTenant(), "pending_operations"));
}

export function decideOperationRecord(
  operation: PendingOperation,
  decision: PendingOperationDecision,
  now: Date,
  userId: string,
): PendingOperation {
  if (operation.state !== "pending") throw new Error("operation already decided");
  if (Date.parse(operation.expiresAt) <= now.getTime()) throw new Error("operation expired");
  if (!REGISTERED_HANDLERS.has(operation.handler as PendingOperationHandler)) {
    throw new Error("operation handler is not registered");
  }
  if (
    typeof operation.arguments.jobId !== "string"
    || typeof operation.arguments.actionId !== "string"
    || typeof operation.arguments.payloadDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(operation.arguments.payloadDigest)
  ) {
    throw new Error("operation is not payload-bound");
  }
  return {
    ...operation,
    state: decision,
    decidedAt: now.toISOString(),
    decidedByUserId: userId,
  };
}

function assertPayloadBoundOperation(operation: PendingOperation): void {
  if (!REGISTERED_HANDLERS.has(operation.handler as PendingOperationHandler)) {
    throw new Error("operation handler is not registered");
  }
  if (
    typeof operation.arguments.jobId !== "string"
    || typeof operation.arguments.actionId !== "string"
    || typeof operation.arguments.payloadDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(operation.arguments.payloadDigest)
  ) throw new Error("operation is not payload-bound");
}

export function claimOperationDecisionRecord(
  operation: PendingOperation,
  decision: PendingOperationDecision,
  now: Date,
  userId: string,
): PendingOperation {
  assertPayloadBoundOperation(operation);
  if (Date.parse(operation.expiresAt) <= now.getTime()) throw new Error("operation expired");
  if (operation.state === "processing") {
    if (operation.pendingDecision !== decision) throw new Error("operation decision mismatch");
    if (Date.parse(operation.decisionLeaseExpiresAt ?? "") > now.getTime()) throw new Error("operation is already processing");
  } else if (operation.state !== "pending") {
    throw new Error("operation already decided");
  }
  return {
    ...operation,
    state: "processing",
    pendingDecision: decision,
    decidedByUserId: userId,
    decisionLeaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    failureReason: undefined,
  };
}

export function finalizeOperationDecisionRecord(
  operation: PendingOperation,
  decision: PendingOperationDecision,
  now: Date,
): PendingOperation {
  if (operation.state !== "processing" || operation.pendingDecision !== decision) {
    throw new Error("operation decision claim mismatch");
  }
  return { ...operation, state: decision, decidedAt: now.toISOString(), decisionLeaseExpiresAt: undefined };
}

export function failOperationDecisionRecord(
  operation: PendingOperation,
  reason: string,
  now: Date,
): PendingOperation {
  if (operation.state !== "processing") throw new Error("operation decision is not processing");
  const failureReason = reason.trim();
  if (!failureReason) throw new Error("operation decision failure reason required");
  return { ...operation, state: "failed", decidedAt: now.toISOString(), decisionLeaseExpiresAt: undefined, failureReason };
}

export async function createPendingOperation(input: {
  handler: PendingOperationHandler;
  title: string;
  description?: string;
  risk: PendingOperation["risk"];
  arguments: Record<string, unknown>;
  ttlMs?: number;
}): Promise<PendingOperation> {
  if (!REGISTERED_HANDLERS.has(input.handler)) throw new Error("operation handler is not registered");
  const tenant = currentTenant();
  const now = new Date();
  const operation: PendingOperation = {
    id: newId(),
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    createdByUserId: tenantSubjectId(tenant),
    handler: input.handler,
    title: input.title,
    description: input.description,
    risk: input.risk,
    arguments: structuredClone(input.arguments),
    state: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? 30 * 60 * 1000)).toISOString(),
  };
  await awsRepository().put(recordKey(collection().partition + "/" + operation.id), operation);
  return operation;
}

export async function getPendingOperation(id: string): Promise<PendingOperation | null> {
  const snap = await awsRepository().read(recordKey(collection().partition + "/" + id));
  if (!snap.present) return null;
  const operation = snap.value as unknown as PendingOperation;
  assertResourceWorkspace(currentTenant(), operation);
  return operation;
}

export async function decidePendingOperation(id: string, decision: PendingOperationDecision): Promise<PendingOperation> {
  const tenant = currentTenant();
  const ref = recordKey(collection().partition + "/" + id);
  return db().atomic(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.present) throw new Error("operation not found");
    const operation = snap.value as unknown as PendingOperation;
    assertResourceWorkspace(tenant, operation);
    const decided = decideOperationRecord(operation, decision, new Date(), tenantSubjectId(tenant));
    transaction.put(ref, decided);
    return decided;
  });
}

export async function claimPendingOperationDecision(id: string, decision: PendingOperationDecision): Promise<PendingOperation> {
  const tenant = currentTenant();
  const ref = recordKey(collection().partition + "/" + id);
  return db().atomic(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.present) throw new Error("operation not found");
    const operation = snap.value as unknown as PendingOperation;
    assertResourceWorkspace(tenant, operation);
    const claimed = claimOperationDecisionRecord(operation, decision, new Date(), tenantSubjectId(tenant));
    transaction.put(ref, claimed);
    return claimed;
  });
}

export async function finalizePendingOperationDecision(id: string, decision: PendingOperationDecision): Promise<PendingOperation> {
  const tenant = currentTenant();
  const ref = recordKey(collection().partition + "/" + id);
  return db().atomic(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.present) throw new Error("operation not found");
    const operation = snap.value as unknown as PendingOperation;
    assertResourceWorkspace(tenant, operation);
    const finalized = finalizeOperationDecisionRecord(operation, decision, new Date());
    transaction.put(ref, finalized);
    return finalized;
  });
}

export async function failPendingOperationDecision(id: string, reason: string): Promise<PendingOperation> {
  const tenant = currentTenant();
  const ref = recordKey(collection().partition + "/" + id);
  return db().atomic(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.present) throw new Error("operation not found");
    const operation = snap.value as unknown as PendingOperation;
    assertResourceWorkspace(tenant, operation);
    const failed = failOperationDecisionRecord(operation, reason, new Date());
    transaction.put(ref, failed);
    return failed;
  });
}
