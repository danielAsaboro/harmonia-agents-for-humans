import { db } from "./firestore";
import { newId } from "./idempotency";
import { assertResourceWorkspace, currentTenant, tenantCollectionPath } from "./tenancy";

export type PendingOperationDecision = "approved" | "rejected";
export type PendingOperationState = "pending" | PendingOperationDecision | "expired";
export type PendingOperationHandler = "publish_preview" | "export_content_pack" | "generate_image" | "render_clip" | "render_reel" | "publish_x_post";

const REGISTERED_HANDLERS = new Set<PendingOperationHandler>([
  "publish_preview",
  "export_content_pack",
  "generate_image",
  "render_clip",
  "render_reel",
  "publish_x_post",
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
}

function collection() {
  return db().collection(tenantCollectionPath(currentTenant(), "pending_operations"));
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
  return {
    ...operation,
    state: decision,
    decidedAt: now.toISOString(),
    decidedByUserId: userId,
  };
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
    createdByUserId: tenant.userId,
    handler: input.handler,
    title: input.title,
    description: input.description,
    risk: input.risk,
    arguments: structuredClone(input.arguments),
    state: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? 30 * 60 * 1000)).toISOString(),
  };
  await collection().doc(operation.id).set(operation);
  return operation;
}

export async function getPendingOperation(id: string): Promise<PendingOperation | null> {
  const snap = await collection().doc(id).get();
  if (!snap.exists) return null;
  const operation = snap.data() as PendingOperation;
  assertResourceWorkspace(currentTenant(), operation);
  return operation;
}

export async function decidePendingOperation(id: string, decision: PendingOperationDecision): Promise<PendingOperation> {
  const tenant = currentTenant();
  const ref = collection().doc(id);
  return db().runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw new Error("operation not found");
    const operation = snap.data() as PendingOperation;
    assertResourceWorkspace(tenant, operation);
    const decided = decideOperationRecord(operation, decision, new Date(), tenant.userId);
    transaction.set(ref, decided);
    return decided;
  });
}
