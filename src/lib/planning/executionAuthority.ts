import { partition, recordKey, where, type DynamoTransaction } from "../dynamo";
import { assertResourceWorkspace } from "../tenancy";
import { currentTenant } from "../tenancy";
import { strategyDigest } from "../strategyApproval";
import type { PlannedItem, PlannedItemState } from "../campaigns/contracts";

/** Reads every persisted execution/effect family under the same transaction fence. */
export async function readPlannedExecutionAuthority(tx: DynamoTransaction, item: PlannedItem, state: PlannedItemState) {
  const expectedJobId = `planned-${strategyDigest(item.ref).slice(0, 56)}`;
  if (state.jobId && state.jobId !== expectedJobId) throw new Error("planned execution identity mismatch");
  const jobPath = `workspaces/${item.workspaceId}/jobs/${expectedJobId}`;
  const row = await tx.read(recordKey(jobPath));
  if (row.present) {
    assertResourceWorkspace(currentTenant(), row.value as { workspaceId: string; brandId: string });
    if (strategyDigest(row.value?.plannedItemRef) !== strategyDigest(item.ref)) throw new Error("planned execution item binding mismatch");
  }
  const commands = await tx.read(where(partition(`workspaces/${item.workspaceId}/effect_commands`), "jobId", "==", expectedJobId));
  const approvals = await tx.read(partition(`${jobPath}/approval_decisions`));
  const claims = await tx.read(partition(`${jobPath}/effect_claims`));
  const receipts = await tx.read(partition(`${jobPath}/receipts`));
  const operations = await tx.read(where(partition(`workspaces/${item.workspaceId}/operations`), "jobId", "==", expectedJobId));
  const commandClaims = [];
  for (const command of commands.rows) {
    assertResourceWorkspace(currentTenant(), command.value as { workspaceId: string; brandId: string });
    commandClaims.push(...(await tx.read(partition(`${command.key.path}/claims`))).rows.map(row => row.value));
  }
  const body = { itemRef: item.ref, job: row.value ?? null, commands: commands.rows.map(row => row.value), approvals: approvals.rows.map(row => row.value), claims: [...claims.rows.map(row => row.value), ...commandClaims], receipts: receipts.rows.map(row => row.value), operations: operations.rows.map(row => row.value), outboxId: state.outboxId ?? null };
  const claimed = Boolean(state.jobId || state.outboxId || row.present || commands.rows.length || approvals.rows.length || claims.rows.length || receipts.rows.length || operations.rows.length);
  const unknown = body.commands.some(command => ["unknown", "dispatched", "waiting_provider"].includes(String(command?.state))) || body.claims.some(claim => ["unknown", "uncertain", "dispatched"].includes(String(claim?.state))) || body.operations.some(operation => operation?.state === "unknown");
  return { claimed, unknown, jobId: claimed ? expectedJobId : null, digest: strategyDigest(body), body };
}
