import { createHash } from "node:crypto";
import { DynamoRepository,limited,partition,recordKey,where } from "./dynamo";

import type { ArtifactRecord } from "./artifacts";
import { requireContentOperator } from "./authority";
import type { EffectCommand } from "./effectCommands";
import type { OperationRecord } from "./operations";
import { canonicalJson } from "./recordReplay/integrity";
import { db } from "./repository";
import { currentTenant,tenantCollectionPath } from "./tenancy";
import type { EffectClaim,Job,PlannedAction,Receipt } from "./types";

type ResolutionJob = Job & { actions: PlannedAction[] };

export type OperationResolutionChoice = "confirm_applied" | "confirm_not_applied" | "compensate" | "cancel";

export interface OperationResolutionRecord {
  id: string;
  schemaVersion: 1;
  workspaceId: string;
  brandId: string;
  jobId: string;
  operationId: string;
  operationEpoch: number;
  commandId: string;
  choice: OperationResolutionChoice;
  reason: string;
  evidence: Array<{ artifactId: string; digest: string }>;
  operationGoalDigest: string;
  commandPayloadDigest: string;
  actorType: "cognito_operator" | "telegram_operator";
  actorSubjectId: string;
  authenticationId: string;
  decidedAt: string;
  digest: string;
}

interface ResolveAggregateInput {
  operation: OperationRecord;
  command: EffectCommand;
  claim: EffectClaim;
  job: ResolutionJob;
  evidence: ArtifactRecord[];
  choice: OperationResolutionChoice;
  reason: string;
  expectedEpoch: number;
  now: string;
}

function withoutUnknownOperation(operation: OperationRecord, state: OperationRecord["state"], now: string): OperationRecord {
  const next = { ...operation, state, updatedAt: now };
  delete next.unresolvedReason;
  delete next.ownerId;
  delete next.ownerTokenDigest;
  delete next.leaseExpiresAt;
  if (["succeeded", "failed", "cancelled"].includes(state)) next.completedAt = now;
  else delete next.completedAt;
  return next;
}

function preparedCommand(command: EffectCommand, now: string): EffectCommand {
  const next = { ...command, state: "prepared" as const, updatedAt: now };
  for (const key of ["operationId", "operationEpoch", "dispatchedAt", "observedAt", "observedOutcome", "observationDigest", "observation", "unknownReason"] as const) {
    delete next[key];
  }
  return next;
}

export function resolveOperationAggregate(input: ResolveAggregateInput): {
  resolution: OperationResolutionRecord;
  operation: OperationRecord;
  command: EffectCommand;
  claim: EffectClaim;
  job: ResolutionJob;
  receipt?: Receipt;
  operatorTask?: { id: string; kind: "compensate_effect"; state: "pending"; operationId: string; evidenceRefs: string[]; createdAt: string };
} {
  const tenant = currentTenant();
  const actor = requireContentOperator(tenant);
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("invalid resolution timestamp");
  if (input.reason.trim().length < 10 || input.reason.length > 2000) throw new Error("operation resolution requires a detailed reason");
  if (input.operation.state !== "unknown" || input.command.state !== "unknown" || input.claim.state !== "unknown") {
    throw new Error("only an unknown effect aggregate can be resolved");
  }
  if (input.operation.epoch !== input.expectedEpoch || input.command.operationEpoch !== input.expectedEpoch || input.claim.operationEpoch !== input.expectedEpoch) {
    throw new Error("operation resolution epoch mismatch");
  }
  if (input.command.operationId !== input.operation.id || input.claim.operationId !== input.operation.id) throw new Error("operation resolution identity mismatch");
  if (input.command.jobId !== input.job.id || input.operation.jobId !== input.job.id || input.claim.jobId !== input.job.id) throw new Error("operation resolution job mismatch");
  if (input.operation.workspaceId !== tenant.workspaceId || input.operation.brandId !== tenant.brandId || input.job.workspaceId !== tenant.workspaceId || input.job.brandId !== tenant.brandId) throw new Error("operation resolution tenant mismatch");
  if (!input.evidence.length || input.evidence.some((item) =>
    item.workspaceId !== tenant.workspaceId || item.brandId !== tenant.brandId
    || item.jobId !== input.job.id || item.state !== "ready" || !/^[a-f0-9]{64}$/.test(item.sha256))) {
    throw new Error("operation resolution requires ready audit evidence");
  }
  const evidence = [...input.evidence]
    .map((item) => ({ artifactId: item.id, digest: item.sha256 }))
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  const resolutionBase = {
    schemaVersion: 1 as const, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
    jobId: input.job.id, operationId: input.operation.id, operationEpoch: input.expectedEpoch,
    commandId: input.command.id, choice: input.choice, reason: input.reason.trim(), evidence,
    operationGoalDigest: input.operation.goal.digest, commandPayloadDigest: input.command.payloadDigest,
    actorType: actor.kind === "cognito_user" ? "cognito_operator" as const : "telegram_operator" as const,
    actorSubjectId: actor.subjectId, authenticationId: actor.authenticationId, decidedAt: input.now,
  };
  const digest = createHash("sha256").update(canonicalJson(resolutionBase)).digest("hex");
  const resolution: OperationResolutionRecord = {
    id: createHash("sha256").update(`${input.operation.id}\0${input.expectedEpoch}`).digest("hex"),
    ...resolutionBase, digest,
  };
  const actions = input.job.actions.map((action) => action.id === input.command.actionId
    ? { ...action, state: input.choice === "confirm_applied" ? "executed" as const : input.choice === "cancel" ? "skipped" as const : input.choice === "compensate" ? "failed" as const : "planned" as const }
    : action);
  const job = { ...input.job, actions, updatedAt: input.now };
  if (input.choice === "confirm_not_applied") {
    return {
      resolution, operation: withoutUnknownOperation(input.operation, "waiting", input.now),
      command: preparedCommand(input.command, input.now),
      claim: { ...input.claim, state: "failed", finalizedAt: input.now }, job,
    };
  }
  if (input.choice === "confirm_applied") {
    const receiptId = `resolution_${resolution.id.slice(0, 32)}`;
    const receipt: Receipt = {
      id: receiptId, jobId: input.job.id, actionId: input.command.actionId,
      idempotencyKey: input.command.payloadDigest, actionType: input.command.actionType,
      performedAt: input.now, outcome: "applied",
      artifact: { kind: "dynamodb_record", url: input.evidence[0].uri, fetchedAt: input.now, digest: input.evidence[0].sha256 },
      detail: { resolutionId: resolution.id, resolutionDigest: resolution.digest, evidenceRefs: evidence.map((item) => item.artifactId), operatorConfirmed: true },
      operationId: input.operation.id, traceId: input.claim.traceId,
    };
    return {
      resolution, operation: withoutUnknownOperation(input.operation, "succeeded", input.now),
      command: { ...input.command, state: "applied", updatedAt: input.now },
      claim: { ...input.claim, state: "applied", receiptId, finalizedAt: input.now }, job, receipt,
    };
  }
  const cancelled = {
    resolution, operation: withoutUnknownOperation(input.operation, "cancelled", input.now),
    command: { ...input.command, state: "cancelled" as const, invalidatedReason: input.reason.trim(), updatedAt: input.now },
    claim: { ...input.claim, state: "failed" as const, finalizedAt: input.now }, job,
  };
  return input.choice === "compensate" ? {
    ...cancelled,
    operatorTask: {
      id: `compensate_${resolution.id.slice(0, 32)}`, kind: "compensate_effect", state: "pending",
      operationId: input.operation.id, evidenceRefs: evidence.map((item) => item.artifactId), createdAt: input.now,
    },
  } : cancelled;
}

export async function resolveUnknownOperation(
  jobId: string,
  operationId: string,
  input: { choice: OperationResolutionChoice; reason: string; expectedEpoch: number; evidence: Array<{ artifactId: string; digest: string }> },
  database: DynamoRepository = db(),
): Promise<{ duplicate: boolean; resolution: OperationResolutionRecord }> {
  const tenant = currentTenant();
  requireContentOperator(tenant);
  const operations = partition(tenantCollectionPath(tenant, "operations"));
  const commands = partition(tenantCollectionPath(tenant, "effect_commands"));
  const artifacts = partition(tenantCollectionPath(tenant, "artifacts"));
  const jobs = partition(tenantCollectionPath(tenant, "jobs"));
  const operationRef = recordKey(operations.partition + "/" + operationId);
  const jobRef = recordKey(jobs.partition + "/" + jobId);
  const resolutionRef = recordKey(partition(jobRef.path + "/" + "operation_resolutions").partition + "/" + createHash("sha256").update(`${operationId}\0${input.expectedEpoch}`).digest("hex"));
  return database.atomic(async (tx) => {
    const commandQuery = limited(where(commands, "operationId", "==", operationId), 2);
    const [operationSnap, jobSnap, commandSnaps, resolutionSnap, ...artifactSnaps] = await Promise.all([
      tx.read(operationRef), tx.read(jobRef), tx.read(commandQuery), tx.read(resolutionRef),
      ...input.evidence.map((item) => tx.read(recordKey(artifacts.partition + "/" + item.artifactId))),
    ]);
    if (!operationSnap.present || !jobSnap.present || commandSnaps.size !== 1) throw new Error("unknown effect aggregate not found");
    const commandSnap = commandSnaps.rows[0];
    const claimRef = recordKey(partition(commandSnap.key.path + "/" + "claims").partition + "/" + "effect");
    const claimSnap = await tx.read(claimRef);
    if (!claimSnap.present) throw new Error("unknown effect claim not found");
    if (resolutionSnap.present) {
      const existing = resolutionSnap.value as unknown as OperationResolutionRecord;
      if (existing.choice !== input.choice || existing.reason !== input.reason.trim() || canonicalJson(existing.evidence) !== canonicalJson([...input.evidence].sort((a, b) => a.artifactId.localeCompare(b.artifactId)))) {
        throw new Error("operation already has a different resolution");
      }
      return { duplicate: true, resolution: existing };
    }
    const evidenceRecords = artifactSnaps.map((snapshot, index) => {
      if (!snapshot.present) throw new Error("resolution evidence artifact not found");
      const record = snapshot.value as unknown as ArtifactRecord;
      if (record.sha256 !== input.evidence[index].digest) throw new Error("resolution evidence digest mismatch");
      return record;
    });
    const result = resolveOperationAggregate({
      operation: operationSnap.value as unknown as OperationRecord,
      command: commandSnap.value as unknown as EffectCommand,
      claim: claimSnap.value as unknown as EffectClaim,
      job: { id: jobSnap.id, ...jobSnap.value } as ResolutionJob,
      evidence: evidenceRecords, choice: input.choice, reason: input.reason,
      expectedEpoch: input.expectedEpoch, now: new Date().toISOString(),
    });
    tx.insert(resolutionRef, result.resolution);
    tx.put(operationRef, result.operation);
    tx.put(commandSnap.key, result.command);
    tx.put(claimRef, result.claim);
    tx.patch(jobRef, { actions: result.job.actions, updatedAt: result.job.updatedAt });
    if (result.receipt) tx.insert(recordKey(partition(jobRef.path + "/" + "receipts").partition + "/" + result.receipt.id), result.receipt);
    if (result.operatorTask) tx.insert(recordKey(partition(jobRef.path + "/" + "operator_tasks").partition + "/" + result.operatorTask.id), result.operatorTask);
    return { duplicate: false, resolution: result.resolution };
  });
}
