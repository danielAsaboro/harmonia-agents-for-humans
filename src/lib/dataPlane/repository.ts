import { awsRepository,partition,recordKey,REMOVE_FIELD,type DynamoRepository } from "../dynamo";

import { assertResourceWorkspace,currentTenant,tenantDocumentPath } from "../tenancy";
import { dataBatchSchema,dataWorkItemSchema,type DataBatch,type DataWorkItem } from "./contracts";
import { reduceBatchOutcome,type BatchOutcome } from "./fanIn";
import {
claimWorkItem,
finalizeWorkItem,
selectDispatchableItems,
type WorkItemClaimInput,
type WorkItemClaimResult,
type WorkItemFinalizeInput,
} from "./workItems";

export class DataPlaneRepository {
  constructor(private readonly repository: DynamoRepository) {}

  private batchRef(batchId: string) {
    return recordKey(tenantDocumentPath(currentTenant(), "data_batches", batchId));
  }

  async create(batchInput: DataBatch, workInput: DataWorkItem[]): Promise<void> {
    const tenant = currentTenant();
    const batch = dataBatchSchema.parse(batchInput);
    assertResourceWorkspace(tenant, batch);
    const work = workInput.map((item) => dataWorkItemSchema.parse(item));
    if (work.length !== batch.manifest.itemCount) throw new Error("batch manifest item count does not match work items");
    const ids = new Set<string>();
    for (const item of work) {
      assertResourceWorkspace(tenant, item);
      if (item.batchId !== batch.id || item.processorVersion !== batch.processorVersion || item.maxAttempts !== batch.maxAttempts) {
        throw new Error("work item does not match batch policy");
      }
      if (ids.has(item.id)) throw new Error("duplicate work item id");
      ids.add(item.id);
    }
    const batchRef = this.batchRef(batch.id);
    await this.repository.atomic(async (transaction) => {
      const existing = await transaction.read(batchRef);
      if (existing.present) {
        const stored = dataBatchSchema.parse(existing.value);
        if (stored.state !== "initializing" && !(stored.state === "failed" && stored.failureCode === "initialization_incomplete")) {
          throw new Error("data batch already exists");
        }
        if (stored.manifest.sha256 !== batch.manifest.sha256 || stored.processorVersion !== batch.processorVersion) {
          throw new Error("data batch initialization identity mismatch");
        }
        transaction.put(batchRef, { ...batch, state: "initializing", failureCode: REMOVE_FIELD });
      } else {
        transaction.insert(batchRef, { ...batch, state: "initializing" });
      }
    });
    try {
      for (let offset = 0; offset < work.length; offset += 25) {
        const writer = this.repository.writeGroup();
        for (const item of work.slice(offset, offset + 25)) writer.put(recordKey(partition(batchRef.path + "/" + "work_items").partition + "/" + item.id), item);
        await writer.commit();
      }
      await awsRepository().patch(batchRef, { state: "pending", updatedAt: new Date().toISOString() });
    } catch (error) {
      await awsRepository().patch(batchRef, { state: "failed", failureCode: "initialization_incomplete", updatedAt: new Date().toISOString() });
      throw error;
    }
  }

  async claim(batchId: string, itemId: string, input: WorkItemClaimInput): Promise<WorkItemClaimResult> {
    const batchRef = this.batchRef(batchId);
    const itemRef = recordKey(partition(batchRef.path + "/" + "work_items").partition + "/" + itemId);
    return this.repository.atomic(async (transaction) => {
      const [batchSnap, itemSnap] = await Promise.all([transaction.read(batchRef), transaction.read(itemRef)]);
      if (!batchSnap.present || !itemSnap.present) throw new Error("data-plane aggregate not found");
      const batch = dataBatchSchema.parse(batchSnap.value);
      const item = dataWorkItemSchema.parse(itemSnap.value);
      assertResourceWorkspace(currentTenant(), batch);
      assertResourceWorkspace(currentTenant(), item);
      if (batch.state === "cancelled") return { outcome: "cancelled", item: { ...item, state: "cancelled" } };
      const result = claimWorkItem(item, input);
      if (result.item !== item) transaction.put(itemRef, result.item);
      if (result.outcome === "execute" && batch.state === "pending") transaction.patch(batchRef, { state: "running", updatedAt: input.now });
      return result;
    });
  }

  async finalize(batchId: string, itemId: string, input: WorkItemFinalizeInput): Promise<DataWorkItem> {
    const batchRef = this.batchRef(batchId);
    const itemRef = recordKey(partition(batchRef.path + "/" + "work_items").partition + "/" + itemId);
    return this.repository.atomic(async (transaction) => {
      const [batchSnapshot, snapshot, itemSnapshots] = await Promise.all([
        transaction.read(batchRef), transaction.read(itemRef), transaction.read(partition(batchRef.path + "/" + "work_items")),
      ]);
      if (!batchSnapshot.present || !snapshot.present) throw new Error("data work item not found");
      const batch = dataBatchSchema.parse(batchSnapshot.value);
      const current = dataWorkItemSchema.parse(snapshot.value);
      assertResourceWorkspace(currentTenant(), current);
      const finalized = finalizeWorkItem(current, input);
      transaction.put(itemRef, finalized);
      const items = itemSnapshots.rows.map((doc) => doc.id === itemId ? finalized : dataWorkItemSchema.parse(doc.value));
      const result = reduceBatchOutcome(items, batch);
      transaction.patch(batchRef, { state: result.outcome, updatedAt: input.now });
      return finalized;
    });
  }

  async getBatch(batchId: string): Promise<DataBatch> {
    const snapshot=await this.repository.read(this.batchRef(batchId));
    if(!snapshot.present)throw new Error("data batch not found");
    const batch=dataBatchSchema.parse(snapshot.value);
    assertResourceWorkspace(currentTenant(),batch);
    return batch;
  }

  async outcome(batchId: string): Promise<BatchOutcome> {
    const batchRef = this.batchRef(batchId);
    const [batchSnapshot, itemSnapshots] = await Promise.all([awsRepository().read(batchRef), awsRepository().query(partition(batchRef.path + "/" + "work_items"))]);
    if (!batchSnapshot.present) throw new Error("data batch not found");
    const batch = dataBatchSchema.parse(batchSnapshot.value);
    assertResourceWorkspace(currentTenant(), batch);
    return reduceBatchOutcome(itemSnapshots.rows.map((doc) => dataWorkItemSchema.parse(doc.value)), batch);
  }

  async dispatchable(batchId: string, now: string): Promise<{ batch: DataBatch; items: DataWorkItem[] }> {
    const batchRef = this.batchRef(batchId);
    const [batchSnapshot, itemSnapshots] = await Promise.all([awsRepository().read(batchRef), awsRepository().query(partition(batchRef.path + "/" + "work_items"))]);
    if (!batchSnapshot.present) throw new Error("data batch not found");
    const batch = dataBatchSchema.parse(batchSnapshot.value);
    assertResourceWorkspace(currentTenant(), batch);
    if (!["pending", "running"].includes(batch.state)) return { batch, items: [] };
    const items = itemSnapshots.rows.map((doc) => dataWorkItemSchema.parse(doc.value));
    return { batch, items: selectDispatchableItems(items, { now, maxInFlight: batch.maxInFlight }) };
  }

  async markDispatched(batchId: string, itemId: string, dispatchedAt: string): Promise<void> {
    if (!Number.isFinite(Date.parse(dispatchedAt))) throw new Error("invalid data work dispatch time");
    const itemRef = recordKey(partition(this.batchRef(batchId).path + "/" + "work_items").partition + "/" + itemId);
    await this.repository.atomic(async (transaction) => {
      const snapshot = await transaction.read(itemRef);
      if (!snapshot.present) throw new Error("data work item not found");
      const item = dataWorkItemSchema.parse(snapshot.value);
      assertResourceWorkspace(currentTenant(), item);
      if (item.state !== "pending" && item.state !== "failed") return;
      transaction.patch(itemRef, { lastDispatchedAt: dispatchedAt, dispatchCount: (item.dispatchCount ?? 0) + 1, updatedAt: dispatchedAt });
    });
  }
}
