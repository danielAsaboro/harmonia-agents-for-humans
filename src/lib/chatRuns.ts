import { parseChatStreamEvent,type ChatStreamEvent } from "./ai-sdk/contracts";
import { awsRepository,limited,ordered,partition,recordKey,where } from "./dynamo";
import { newId } from "./idempotency";
import { db } from "./repository";
import { assertResourceWorkspace,currentTenant,tenantCollectionPath,tenantSubjectId } from "./tenancy";

export type UnsequencedChatStreamEvent = ChatStreamEvent extends infer Event
  ? Event extends { runId: string; sequence: number }
    ? Omit<Event, "runId" | "sequence">
    : never
  : never;

export interface ChatRunDoc {
  id: string;
  workspaceId: string;
  brandId: string;
  createdByUserId: string;
  message: string;
  attachmentIds: string[];
  status: "running" | "complete" | "failed" | "cancelled";
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
}

function collection() {
  return partition(tenantCollectionPath(currentTenant(), "chat_runs"));
}

export async function createChatRun(message: string, attachmentIds: string[]): Promise<ChatRunDoc> {
  const tenant = currentTenant();
  const now = new Date().toISOString();
  const run: ChatRunDoc = {
    id: newId(),
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    createdByUserId: tenantSubjectId(tenant),
    message,
    attachmentIds: [...new Set(attachmentIds)],
    status: "running",
    lastSequence: -1,
    createdAt: now,
    updatedAt: now,
  };
  await awsRepository().put(recordKey(collection().partition + "/" + run.id), run);
  return run;
}

export async function getChatRun(id: string): Promise<ChatRunDoc | null> {
  const snap = await awsRepository().read(recordKey(collection().partition + "/" + id));
  if (!snap.present) return null;
  const run = snap.value as unknown as ChatRunDoc;
  assertResourceWorkspace(currentTenant(), run);
  return run;
}

export async function appendChatRunEvent(runId: string, input: UnsequencedChatStreamEvent): Promise<ChatStreamEvent> {
  const runRef = recordKey(collection().partition + "/" + runId);
  return db().atomic(async (transaction) => {
    const runSnap = await transaction.read(runRef);
    if (!runSnap.present) throw new Error("chat run not found");
    const run = runSnap.value as unknown as ChatRunDoc;
    assertResourceWorkspace(currentTenant(), run);
    if (run.status !== "running" && input.type !== "run_failed") throw new Error("chat run is terminal");
    const sequence = run.lastSequence + 1;
    const event = parseChatStreamEvent({ ...input, runId, sequence });
    const terminal = event.type === "run_completed" ? "complete" : event.type === "run_failed" ? "failed" : run.status;
    const updatedAt = new Date().toISOString();
    transaction.put(recordKey(partition(runRef.path + "/" + "events").partition + "/" + String(sequence).padStart(12, "0")), event);
    transaction.patch(runRef, { lastSequence: sequence, status: terminal, updatedAt });
    return event;
  });
}

export async function listChatRunEvents(runId: string, afterSequence = -1): Promise<ChatStreamEvent[]> {
  const run = await getChatRun(runId);
  if (!run) throw new Error("chat run not found");
  const snaps = await awsRepository().query(limited(ordered(where(partition(recordKey(collection().partition + "/" + runId).path + "/" + "events"), "sequence", ">", afterSequence), "sequence", "asc"), 500));
  return snaps.rows.map((doc) => parseChatStreamEvent(doc.value));
}
