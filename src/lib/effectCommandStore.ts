import { db } from "./firestore";
import { decideEffectClaim, decideEffectFinalization } from "./effectClaims";
import { effectCommandDigest, type EffectCommand } from "./effectCommands";
import { currentTenant, tenantCollectionPath } from "./tenancy";
import type { EffectClaim, EffectClaimInput, EffectClaimOutcome, Job, PlannedAction, Receipt } from "./types";

const COMMANDS = "effect_commands";
const CLAIMS = "claims";
const JOBS = "jobs";
const RECEIPTS = "receipts";
const CONTENT_ITEMS = "content_items";

function commands() {
  return db().collection(tenantCollectionPath(currentTenant(), COMMANDS));
}

function assertStoredCommand(command: EffectCommand): void {
  const digest = effectCommandDigest(command);
  if (digest !== command.payloadDigest) throw new Error("effect command payload changed");
  const authorized = command.authorization.kind === "approval"
    ? command.authorization.approvedPayloadDigest
    : command.authorization.authorizedPayloadDigest;
  if (authorized !== digest) throw new Error("effect command authorization mismatch");
}

function assertCommandTenant(command: EffectCommand): void {
  const tenant = currentTenant();
  if (command.workspaceId !== tenant.workspaceId || command.brandId !== tenant.brandId) {
    throw new Error("effect command tenant mismatch");
  }
}

export function commandClaimInput(
  command: EffectCommand,
  input: Pick<EffectClaimInput, "claimToken" | "operationId" | "traceId">,
): EffectClaimInput {
  assertStoredCommand(command);
  return {
    jobId: command.jobId,
    actionId: command.actionId,
    actionType: command.actionType,
    idempotencyKey: command.payloadDigest,
    ...input,
  };
}

export function assertCommandReceipt(command: EffectCommand, receipt: Receipt): void {
  assertStoredCommand(command);
  if (
    receipt.jobId !== command.jobId
    || receipt.actionId !== command.actionId
    || receipt.actionType !== command.actionType
    || receipt.idempotencyKey !== command.payloadDigest
  ) {
    throw new Error("receipt does not match immutable command");
  }
}

export async function createCommand(command: EffectCommand): Promise<void> {
  assertStoredCommand(command);
  assertCommandTenant(command);
  await commands().doc(command.id).create(command);
}

export async function getCommand(commandId: string): Promise<EffectCommand | null> {
  const snap = await commands().doc(commandId).get();
  if (!snap.exists) return null;
  const command = snap.data() as EffectCommand;
  assertStoredCommand(command);
  assertCommandTenant(command);
  return command;
}

export async function listDueCommands(now = new Date()): Promise<EffectCommand[]> {
  const snaps = await commands().where("state", "==", "pending").get();
  return snaps.docs
    .map((doc) => doc.data() as EffectCommand)
    .filter((command) => !command.executeAfter || Date.parse(command.executeAfter) <= now.getTime())
    .sort((a, b) => Date.parse(a.executeAfter ?? a.createdAt) - Date.parse(b.executeAfter ?? b.createdAt));
}

export async function listCommandsForJob(jobId: string): Promise<EffectCommand[]> {
  const snaps = await commands().where("jobId", "==", jobId).get();
  return snaps.docs.map((doc) => doc.data() as EffectCommand).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function claimCommandEffect(
  commandId: string,
  owner: Pick<EffectClaimInput, "claimToken" | "operationId" | "traceId">,
): Promise<EffectClaimOutcome> {
  const commandRef = commands().doc(commandId);
  const claimRef = commandRef.collection(CLAIMS).doc("effect");
  return db().runTransaction(async (tx) => {
    const [commandSnap, claimSnap] = await Promise.all([tx.get(commandRef), tx.get(claimRef)]);
    if (!commandSnap.exists) throw new Error("effect command not found");
    const command = commandSnap.data() as EffectCommand;
    assertStoredCommand(command);
    assertCommandTenant(command);
    if (command.state === "cancelled" || command.state === "failed") throw new Error(`effect command is ${command.state}`);
    if (command.executeAfter && Date.parse(command.executeAfter) > Date.now()) throw new Error("effect command is not due");
    const input = commandClaimInput(command, owner);
    const result = decideEffectClaim(claimSnap.exists ? claimSnap.data() as EffectClaim : null, input);
    if (result.outcome === "execute") {
      tx.set(claimRef, result.claim);
      tx.update(commandRef, { state: "claimed", updatedAt: result.claim.claimedAt });
    } else if (result.outcome === "uncertain" && command.state !== "uncertain") {
      tx.update(commandRef, { state: "uncertain", updatedAt: new Date().toISOString() });
    }
    return result;
  });
}

export async function finalizeCommandReceipt(
  commandId: string,
  receipt: Receipt,
  claimToken: string,
): Promise<{ duplicate: boolean; receipt: Receipt }> {
  const tenant = currentTenant();
  const commandRef = commands().doc(commandId);
  const claimRef = commandRef.collection(CLAIMS).doc("effect");
  const jobRef = db().collection(tenantCollectionPath(tenant, JOBS)).doc(receipt.jobId);
  const receiptRef = jobRef.collection(RECEIPTS).doc(receipt.id);
  return db().runTransaction(async (tx) => {
    const [commandSnap, claimSnap, jobSnap] = await Promise.all([
      tx.get(commandRef), tx.get(claimRef), tx.get(jobRef),
    ]);
    if (!commandSnap.exists || !claimSnap.exists) throw new Error("effect command claim not found");
    const command = commandSnap.data() as EffectCommand;
    assertCommandReceipt(command, receipt);
    assertCommandTenant(command);
    const claim = claimSnap.data() as EffectClaim;
    const finalized = decideEffectFinalization(claim, claimToken, receipt.id, receipt.outcome);
    if (finalized.duplicate) {
      const original = await tx.get(jobRef.collection(RECEIPTS).doc(finalized.receiptId));
      if (!original.exists) throw new Error("finalized command receipt is missing");
      return { duplicate: true, receipt: original.data() as Receipt };
    }
    const commandState = receipt.outcome === "applied" || receipt.outcome === "already_applied" ? "applied" : "failed";
    if (command.sourceKind === "job_action") {
      if (!jobSnap.exists) throw new Error("effect command job not found");
      const job = jobSnap.data() as Job & { actions?: PlannedAction[] };
      const actions = [...(job.actions ?? [])];
      const index = actions.findIndex((action) => action.id === command.actionId);
      if (index < 0) throw new Error("effect command action not found");
      actions[index] = { ...actions[index], state: commandState === "applied" ? "executed" : "failed" };
      tx.update(jobRef, { actions, updatedAt: receipt.performedAt });
    } else {
      const itemRef = db().collection(tenantCollectionPath(tenant, CONTENT_ITEMS)).doc(command.sourceId);
      const itemSnap = await tx.get(itemRef);
      if (!itemSnap.exists) throw new Error("scheduled content source not found");
      tx.update(itemRef, commandState === "applied"
        ? { status: "published", publishedAt: receipt.performedAt, updatedAt: receipt.performedAt }
        : { status: "failed", failureReason: String(receipt.detail.error ?? receipt.outcome), updatedAt: receipt.performedAt });
    }
    tx.create(receiptRef, receipt);
    tx.set(claimRef, finalized.claim);
    tx.update(commandRef, { state: commandState, updatedAt: receipt.performedAt });
    return { duplicate: false, receipt };
  });
}
