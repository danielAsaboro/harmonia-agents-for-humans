import { createHash,randomUUID } from "node:crypto";
import { awsRepository,field,ordered,partition,recordKey,REMOVE_FIELD } from "../dynamo";
import { db } from "../repository";
import { currentTenant } from "../tenancy";
import { brandLibraryConnectionSchema,brandLibrarySnapshotSchema,type BrandLibraryConnection,type BrandLibrarySnapshot,type LibraryFileVersion } from "./contracts";

const root = () => partition(`workspaces/${currentTenant().workspaceId}/brands/${currentTenant().brandId}/brand_libraries`);

export async function createLibraryConnection(input: Omit<BrandLibraryConnection, "id" | "workspaceId" | "brandId" | "revision" | "createdAt" | "updatedAt" | "lastSyncStatus" | "retryCount">): Promise<BrandLibraryConnection> {
  const tenant = currentTenant(); const now = new Date().toISOString();
  const connection = brandLibraryConnectionSchema.parse({ ...input, id: randomUUID(), workspaceId: tenant.workspaceId, brandId: tenant.brandId, revision: 1, lastSyncStatus: "never", retryCount: 0, createdAt: now, updatedAt: now });
  await awsRepository().insert(recordKey(root().partition + "/" + connection.id), connection); return connection;
}

export async function listLibraryConnections(): Promise<BrandLibraryConnection[]> {
  const snapshot = await awsRepository().query(ordered(root(), "createdAt", "desc"));
  return snapshot.rows.map((doc) => brandLibraryConnectionSchema.parse(doc.value));
}

export async function getLibraryConnection(id: string): Promise<BrandLibraryConnection> {
  const snapshot = await awsRepository().read(recordKey(root().partition + "/" + id));
  if (!snapshot.present) throw new Error("library connection not found");
  return brandLibraryConnectionSchema.parse(snapshot.value);
}

export async function beginLibrarySync(connectionId: string, expectedRevision: number): Promise<{ id: string; connection: BrandLibraryConnection }> {
  const ref = recordKey(root().partition + "/" + connectionId); const operationId = randomUUID(); const now = new Date().toISOString(); let connection!: BrandLibraryConnection;
  await db().atomic(async (transaction) => {
    const snapshot = await transaction.read(ref); connection = brandLibraryConnectionSchema.parse(snapshot.value);
    if (connection.revision !== expectedRevision || connection.revokedAt || connection.cadence === "paused" || connection.lastSyncStatus === "reconnection_required" || connection.lastSyncStatus === "permanent_failure" || (connection.nextEligibleRetryAt && Date.parse(connection.nextEligibleRetryAt) > Date.now())) throw new Error("library connection cannot be synchronized at this revision");
    if (connection.lastSyncStatus === "running") throw new Error("library sync already running");
    transaction.insert(recordKey(partition(ref.path + "/" + "sync_operations").partition + "/" + operationId), { id: operationId, connectionId, expectedConnectionRevision: expectedRevision, status: "claimed", startedAt: now });
    transaction.patch(ref, { lastSyncStatus: "running", updatedAt: now });
  });
  return { id: operationId, connection };
}

export async function latestHealthySnapshot(connectionId: string): Promise<BrandLibrarySnapshot | null> {
  const connection = await awsRepository().read(recordKey(root().partition + "/" + connectionId));
  if (!connection.present) throw new Error("library connection not found");
  const id = field(connection.value, "currentHealthySnapshotId") as string | undefined;
  if (!id) return null;
  const snapshot = await awsRepository().read(recordKey(partition(connection.key.path + "/" + "snapshots").partition + "/" + id));
  return snapshot.present ? brandLibrarySnapshotSchema.parse(snapshot.value) : null;
}

export async function promoteHealthySnapshot(connectionId: string, expectedRevision: number, syncOperationId: string, files: LibraryFileVersion[]): Promise<BrandLibrarySnapshot> {
  const connectionRef = recordKey(root().partition + "/" + connectionId); const now = new Date().toISOString(); const snapshotId = randomUUID();
  const canonical = [...files].sort((a, b) => a.providerResourceId.localeCompare(b.providerResourceId));
  const snapshot = brandLibrarySnapshotSchema.parse({ id: snapshotId, connectionId, revision: expectedRevision, syncOperationId, status: "healthy", fileVersions: canonical, manifestDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"), createdAt: now });
  await db().atomic(async (transaction) => {
    const current = await transaction.read(connectionRef);
    if (!current.present || field(current.value, "revision") !== expectedRevision || field(current.value, "revokedAt")) throw new Error("stale or revoked library connection");
    const snapshotRef = recordKey(partition(connectionRef.path + "/" + "snapshots").partition + "/" + snapshotId);
    transaction.insert(snapshotRef, snapshot);
    transaction.patch(connectionRef, { currentHealthySnapshotId: snapshotId, lastSyncStatus: "healthy", retryCount: 0, nextEligibleRetryAt: REMOVE_FIELD, revision: expectedRevision + 1, updatedAt: now });
  });
  return snapshot;
}

export async function failLibrarySync(connectionId: string, expectedRevision: number, failure: { category: "transient" | "reconnection_required" | "permanent"; retryCount: number; nextEligibleRetryAt?: string }): Promise<void> {
  const ref = recordKey(root().partition + "/" + connectionId); const current = await awsRepository().read(ref);
  if (!current.present || field(current.value, "revision") !== expectedRevision) throw new Error("stale library connection");
  const lastSyncStatus = failure.category === "reconnection_required" ? "reconnection_required" : `${failure.category}_failure`;
  await awsRepository().patch(ref, { lastSyncStatus, retryCount: failure.retryCount, nextEligibleRetryAt: failure.nextEligibleRetryAt ?? REMOVE_FIELD, revision: expectedRevision + 1, updatedAt: new Date().toISOString() });
}

export async function finalizeLibrarySyncOperation(connectionId: string, operationId: string, status: "healthy" | "failed", failure?: { code: string; category: "transient" | "reconnection_required" | "permanent"; publicMessage: string; retryCount: number; nextEligibleRetryAt?: string }): Promise<void> { const now = new Date().toISOString(); await awsRepository().patch(recordKey(partition(recordKey(root().partition + "/" + connectionId).path + "/" + "sync_operations").partition + "/" + operationId), { status, completedAt: now, ...(failure ? { failure } : {}) }); }
