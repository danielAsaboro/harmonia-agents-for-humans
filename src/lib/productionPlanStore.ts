import { createHash } from "node:crypto";

import { db } from "./firestore";
import {
  assertProductionMandateAuthorizes,
  compileProductionOperations,
  createProductionMandate,
  productionMandateSchema,
  productionOperationSchema,
  productionPlanDigest,
  videoProductionPlanSchema,
  type ProductionMandate,
  type ProductionOperation,
  type VideoProductionPlan,
} from "./mediaProduction";
import { requireProductionOperator, requireService } from "./authority";
import { currentTenant } from "./tenancy";

const DOCUMENT_ID = /^[A-Za-z0-9:_-]{1,256}$/;

export type ProductionPlanState = "proposed" | "sealed" | "approved" | "rejected";

export interface ProductionPlanAggregate {
  id: string;
  jobId: string;
  workspaceId: string;
  brandId: string;
  state: ProductionPlanState;
  currentRevision: number;
  currentPlanDigest: string;
  activeMandateId: string | null;
  currentMandateReservedCostUsd: string;
  createdAt: string;
  updatedAt: string;
  sealedAt?: string;
  decidedAt?: string;
}

export interface ProductionPlanRevision {
  revision: number;
  plan: VideoProductionPlan;
  planDigest: string;
  operations: ProductionOperation[];
  proposedAt: string;
}

export interface PaidProductionOperationClaim {
  kind: "paid";
  id: string;
  planId: string;
  jobId: string;
  workspaceId: string;
  brandId: string;
  planRevision: number;
  planDigest: string;
  operationId: string;
  requestDigest: string;
  mandateId: string;
  state: "claimed" | "submitting" | "waiting_provider" | "succeeded" | "failed" | "uncertain";
  reservedCostUsd: string;
  pricingVersion: string;
  claimTokenDigest: string;
  claimedAt: string;
  leaseExpiresAt: string;
  attempt: number;
  provider?: "veo" | "lyria";
  providerOperationId?: string;
  nextPollAt?: string;
  artifact?: {
    objectKey: string;
    mime: string;
    digest: string;
    sizeBytes: number;
  };
  providerMetadata?: Record<string, unknown>;
  completedAt?: string;
  failureReason?: string;
  failedAt?: string;
  submissionStartedAt?: string;
}

export interface InternalProductionOperationClaim {
  kind: "internal";
  id: string;
  planId: string;
  jobId: string;
  workspaceId: string;
  brandId: string;
  planRevision: number;
  planDigest: string;
  operationId: string;
  requestDigest: string;
  state: "claimed" | "succeeded" | "failed";
  claimTokenDigest: string;
  claimedAt: string;
  leaseExpiresAt: string;
  attempt: number;
  inputDigests: Array<{ operationId: string; digest: string }>;
  artifact?: NonNullable<PaidProductionOperationClaim["artifact"]>;
  operationMetadata?: Record<string, unknown>;
  completedAt?: string;
  failureReason?: string;
  failedAt?: string;
}

export type ProductionOperationClaim = PaidProductionOperationClaim | InternalProductionOperationClaim;

export interface ProductionOperationInput {
  operationId: string;
  artifact: NonNullable<ProductionOperationClaim["artifact"]>;
}

export interface ProductionPlanWorkspaceOperation {
  id: string;
  type: ProductionOperation["type"];
  executionAuthority: ProductionOperation["executionAuthority"];
  dependsOn: string[];
  estimatedCostUsd?: string;
  state: "pending" | ProductionOperationClaim["state"];
  attempt: number;
  provider?: "veo" | "lyria";
  providerOperationId?: string;
  artifact?: { mime: string; digest: string; sizeBytes: number };
  metadata?: Record<string, unknown>;
  failureReason?: string;
  claimedAt?: string;
  completedAt?: string;
}

export interface ProductionPlanWorkspaceView {
  aggregate: ProductionPlanAggregate;
  revision: ProductionPlanRevision;
  operations: ProductionPlanWorkspaceOperation[];
}

export type PaidProductionClaimOutcome = {
  outcome: "execute" | "in_progress" | "already_succeeded" | "failed" | "uncertain";
  claim: PaidProductionOperationClaim;
  operation: ProductionOperation;
};

export type ProductionClaimOutcome =
  | PaidProductionClaimOutcome
  | {
    outcome: "execute" | "in_progress" | "already_succeeded" | "failed";
    claim: InternalProductionOperationClaim;
    operation: ProductionOperation;
    plan: VideoProductionPlan;
    inputs: ProductionOperationInput[];
  };

export interface ProductionOperationOutboxRecord {
  id: string;
  workspaceId: string;
  brandId: string;
  planId: string;
  jobId: string;
  planRevision: number;
  planDigest: string;
  operationId: string;
  state: "pending" | "publishing" | "published" | "completed" | "superseded";
  availableAt: string;
  publishAttempt: number;
  createdAt: string;
  updatedAt: string;
  publishTokenDigest?: string;
  publishLeaseExpiresAt?: string;
  pubsubMessageId?: string;
}

function checkedDocumentId(label: string, value: string): string {
  if (!DOCUMENT_ID.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function usdMicros(value: string): bigint {
  if (!/^\d+\.\d{6}$/.test(value)) throw new Error("invalid production operation estimated cost");
  return BigInt(value.replace(".", ""));
}

function microsUsd(value: bigint): string {
  const digits = value.toString().padStart(7, "0");
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

function claimTokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationClaimId(revision: number, planDigest: string, operationId: string): string {
  return createHash("sha256").update(`${revision}\n${planDigest}\n${operationId}`).digest("hex");
}

function productionOutboxRecord(
  aggregate: ProductionPlanAggregate,
  operation: ProductionOperation,
  availableAt: string,
): ProductionOperationOutboxRecord {
  const tenant = currentTenant();
  const id = operationClaimId(aggregate.currentRevision, aggregate.currentPlanDigest, operation.id);
  return {
    id,
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    planId: aggregate.id,
    jobId: aggregate.jobId,
    planRevision: aggregate.currentRevision,
    planDigest: aggregate.currentPlanDigest,
    operationId: operation.id,
    state: "pending",
    availableAt,
    publishAttempt: 0,
    createdAt: availableAt,
    updatedAt: availableAt,
  };
}

function assertClaimOwner(
  claim: { id: string; claimTokenDigest: string },
  claimId: string,
  claimToken: string,
): void {
  if (claim.id !== claimId || claim.claimTokenDigest !== claimTokenDigest(claimToken)) {
    throw new Error("production operation claim ownership mismatch");
  }
}

function plans() {
  const tenant = currentTenant();
  return db().collection("workspaces").doc(tenant.workspaceId)
    .collection("brands").doc(tenant.brandId).collection("production_plans");
}

function planRef(planId: string) {
  return plans().doc(checkedDocumentId("production plan id", planId));
}

function productionPlanBindingRef(jobId: string) {
  const tenant = currentTenant();
  return db().collection("workspaces").doc(tenant.workspaceId)
    .collection("jobs").doc(checkedDocumentId("production job id", jobId))
    .collection("production_plan_binding").doc("current");
}

function productionOutbox() {
  const tenant = currentTenant();
  return db().collection("workspaces").doc(tenant.workspaceId)
    .collection("brands").doc(tenant.brandId).collection("production_operation_outbox");
}

function productionOutboxRef(id: string) {
  return productionOutbox().doc(checkedDocumentId("production outbox id", id));
}

function revisionRef(planId: string, revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid production plan revision");
  return planRef(planId).collection("revisions").doc(`v${revision}`);
}

function assertAggregate(value: unknown): ProductionPlanAggregate {
  if (!value || typeof value !== "object") throw new Error("invalid production plan aggregate");
  const aggregate = value as ProductionPlanAggregate;
  const tenant = currentTenant();
  if (aggregate.workspaceId !== tenant.workspaceId || aggregate.brandId !== tenant.brandId) {
    throw new Error("production plan tenant mismatch");
  }
  if (!DOCUMENT_ID.test(aggregate.id) || !DOCUMENT_ID.test(aggregate.jobId)) {
    throw new Error("invalid production plan aggregate identity");
  }
  if (!["proposed", "sealed", "approved", "rejected"].includes(aggregate.state)) {
    throw new Error("invalid production plan state");
  }
  if (!Number.isSafeInteger(aggregate.currentRevision) || aggregate.currentRevision < 1) {
    throw new Error("invalid current production plan revision");
  }
  if (!/^[a-f0-9]{64}$/.test(aggregate.currentPlanDigest)) {
    throw new Error("invalid current production plan digest");
  }
  usdMicros(aggregate.currentMandateReservedCostUsd);
  return aggregate;
}

function assertRevision(value: unknown): ProductionPlanRevision {
  if (!value || typeof value !== "object") throw new Error("invalid production plan revision");
  const record = value as ProductionPlanRevision;
  const plan = videoProductionPlanSchema.parse(record.plan);
  const operations = record.operations.map((operation) => productionOperationSchema.parse(operation));
  if (record.revision !== plan.revision || record.planDigest !== productionPlanDigest(plan)) {
    throw new Error("production plan revision digest mismatch");
  }
  if (JSON.stringify(operations) !== JSON.stringify(compileProductionOperations(plan))) {
    throw new Error("production plan operation graph mismatch");
  }
  return { ...record, plan, operations };
}

export async function proposeProductionPlan(
  input: VideoProductionPlan,
  proposedAt = new Date().toISOString(),
): Promise<ProductionPlanAggregate> {
  const plan = videoProductionPlanSchema.parse(input);
  const tenant = currentTenant();
  if (plan.workspaceId !== tenant.workspaceId || plan.brandId !== tenant.brandId) {
    throw new Error("production plan tenant mismatch");
  }
  checkedDocumentId("production plan id", plan.id);
  checkedDocumentId("production job id", plan.jobId);
  const aggregateRef = planRef(plan.id);
  const immutableRevisionRef = revisionRef(plan.id, plan.revision);
  const jobRef = db().collection("workspaces").doc(tenant.workspaceId).collection("jobs").doc(plan.jobId);
  const bindingRef = productionPlanBindingRef(plan.jobId);
  const digest = productionPlanDigest(plan);
  const revision: ProductionPlanRevision = {
    revision: plan.revision,
    plan,
    planDigest: digest,
    operations: compileProductionOperations(plan),
    proposedAt,
  };
  return db().runTransaction(async (tx) => {
    const [aggregateSnap, revisionSnap, jobSnap, bindingSnap] = await Promise.all([
      tx.get(aggregateRef),
      tx.get(immutableRevisionRef),
      tx.get(jobRef),
      tx.get(bindingRef),
    ]);
    if (!jobSnap.exists) throw new Error("production plan job not found");
    if (jobSnap.get("workspaceId") !== tenant.workspaceId || jobSnap.get("brandId") !== tenant.brandId) {
      throw new Error("production plan job tenant mismatch");
    }
    if (revisionSnap.exists) throw new Error(`production plan revision ${plan.revision} already exists`);
    if (bindingSnap.exists) {
      const binding = bindingSnap.data();
      if (binding?.workspaceId !== tenant.workspaceId || binding?.brandId !== tenant.brandId
        || binding?.jobId !== plan.jobId) {
        throw new Error("production plan binding tenant mismatch");
      }
      if (binding.planId !== plan.id) {
        throw new Error(`production job ${plan.jobId} is already bound to production plan ${binding.planId}`);
      }
    }
    const existing = aggregateSnap.exists ? assertAggregate(aggregateSnap.data()) : null;
    const expectedRevision = existing ? existing.currentRevision + 1 : 1;
    if (plan.revision !== expectedRevision) throw new Error(`expected production plan revision ${expectedRevision}`);
    if (existing && existing.jobId !== plan.jobId) throw new Error("production plan job cannot change");
    if (existing) {
      const priorRevisionSnap = await tx.get(revisionRef(plan.id, existing.currentRevision));
      if (!priorRevisionSnap.exists) throw new Error("current production plan revision not found");
      const priorOperations = assertRevision(priorRevisionSnap.data()).operations;
      const priorOutboxSnaps = await Promise.all(priorOperations.map((operation) => tx.get(productionOutboxRef(
        operationClaimId(existing.currentRevision, existing.currentPlanDigest, operation.id),
      ))));
      for (const [index, operation] of priorOperations.entries()) {
        if (!priorOutboxSnaps[index].exists) continue;
        const priorOutboxId = operationClaimId(existing.currentRevision, existing.currentPlanDigest, operation.id);
        tx.set(productionOutboxRef(priorOutboxId), {
          state: "superseded",
          updatedAt: proposedAt,
        }, { merge: true });
      }
    }
    const aggregate: ProductionPlanAggregate = {
      id: plan.id,
      jobId: plan.jobId,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
      state: "proposed",
      currentRevision: plan.revision,
      currentPlanDigest: digest,
      activeMandateId: null,
      currentMandateReservedCostUsd: "0.000000",
      createdAt: existing?.createdAt ?? proposedAt,
      updatedAt: proposedAt,
    };
    tx.create(immutableRevisionRef, revision);
    if (aggregateSnap.exists) tx.set(aggregateRef, aggregate);
    else tx.create(aggregateRef, aggregate);
    if (!bindingSnap.exists) {
      tx.create(bindingRef, {
        planId: plan.id,
        jobId: plan.jobId,
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        createdAt: proposedAt,
        updatedAt: proposedAt,
      });
    }
    return aggregate;
  });
}

export async function getProductionPlan(planId: string): Promise<ProductionPlanAggregate | null> {
  const snap = await planRef(planId).get();
  return snap.exists ? assertAggregate(snap.data()) : null;
}

export async function getProductionPlanRevision(
  planId: string,
  revision: number,
): Promise<ProductionPlanRevision | null> {
  const snap = await revisionRef(planId, revision).get();
  return snap.exists ? assertRevision(snap.data()) : null;
}

export async function getProductionPlanWorkspaceForJob(
  jobId: string,
): Promise<ProductionPlanWorkspaceView | null> {
  checkedDocumentId("production job id", jobId);
  const tenant = currentTenant();
  const bindingSnap = await productionPlanBindingRef(jobId).get();
  if (!bindingSnap.exists) return null;
  const binding = bindingSnap.data();
  if (binding?.workspaceId !== tenant.workspaceId || binding?.brandId !== tenant.brandId
    || binding?.jobId !== jobId || typeof binding?.planId !== "string") {
    throw new Error("production plan binding tenant mismatch");
  }
  const aggregate = await getProductionPlan(binding.planId);
  if (!aggregate) throw new Error("bound production plan not found");
  if (aggregate.jobId !== jobId) throw new Error("production plan binding job mismatch");
  const revision = await getProductionPlanRevision(aggregate.id, aggregate.currentRevision);
  if (!revision) throw new Error("production plan revision not found");
  const claims = await planRef(aggregate.id).collection("operation_claims").get();
  const claimsById = new Map(claims.docs.map((snapshot) => {
    const claim = snapshot.data() as ProductionOperationClaim;
    if (claim.workspaceId !== tenant.workspaceId || claim.brandId !== tenant.brandId || claim.planId !== aggregate.id) {
      throw new Error("production operation claim tenant mismatch");
    }
    return [claim.id, claim] as const;
  }));
  const operations = revision.operations.map((operation): ProductionPlanWorkspaceOperation => {
    const claim = claimsById.get(operationClaimId(
      aggregate.currentRevision, aggregate.currentPlanDigest, operation.id,
    ));
    return {
      id: operation.id,
      type: operation.type,
      executionAuthority: operation.executionAuthority,
      dependsOn: [...operation.dependsOn],
      ...(operation.estimatedCostUsd ? { estimatedCostUsd: operation.estimatedCostUsd } : {}),
      state: claim?.state ?? "pending",
      attempt: claim?.attempt ?? 0,
      ...(claim?.kind === "paid" && claim.provider ? { provider: claim.provider } : {}),
      ...(claim?.kind === "paid" && claim.providerOperationId ? { providerOperationId: claim.providerOperationId } : {}),
      ...(claim?.artifact ? { artifact: {
        mime: claim.artifact.mime,
        digest: claim.artifact.digest,
        sizeBytes: claim.artifact.sizeBytes,
      } } : {}),
      ...(claim?.kind === "paid" && claim.providerMetadata ? { metadata: claim.providerMetadata }
        : claim?.kind === "internal" && claim.operationMetadata ? { metadata: claim.operationMetadata } : {}),
      ...(claim?.failureReason ? { failureReason: claim.failureReason } : {}),
      ...(claim?.claimedAt ? { claimedAt: claim.claimedAt } : {}),
      ...(claim?.completedAt ? { completedAt: claim.completedAt } : {}),
    };
  });
  return { aggregate, revision, operations };
}

export async function getProductionOperationArtifact(
  planId: string,
  operationId: string,
): Promise<NonNullable<ProductionOperationClaim["artifact"]>> {
  const tenant = currentTenant();
  requireService(tenant);
  const aggregate = await getProductionPlan(planId);
  if (!aggregate) throw new Error("production plan not found");
  const revision = await getProductionPlanRevision(planId, aggregate.currentRevision);
  if (!revision?.operations.some((operation) => operation.id === operationId)) {
    throw new Error("production operation not found in current revision");
  }
  const id = operationClaimId(aggregate.currentRevision, aggregate.currentPlanDigest, operationId);
  const snap = await planRef(planId).collection("operation_claims").doc(id).get();
  if (!snap.exists) throw new Error("production operation claim not found");
  const claim = snap.data() as ProductionOperationClaim;
  if (claim.state !== "succeeded" || !claim.artifact) throw new Error("production artifact is not ready");
  return claim.artifact;
}

export async function sealProductionPlan(
  planId: string,
  input: { planDigest: string; sealedAt?: string },
): Promise<ProductionPlanAggregate> {
  const aggregateRef = planRef(planId);
  const sealedAt = input.sealedAt ?? new Date().toISOString();
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(aggregateRef);
    if (!snap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(snap.data());
    if (aggregate.state !== "proposed") throw new Error(`cannot seal ${aggregate.state} production plan`);
    if (aggregate.currentPlanDigest !== input.planDigest) throw new Error("production plan changed before sealing");
    const updated: ProductionPlanAggregate = { ...aggregate, state: "sealed", sealedAt, updatedAt: sealedAt };
    tx.set(aggregateRef, updated);
    return updated;
  });
}

export async function approveProductionPlan(
  planId: string,
  input: { planDigest: string; approvedAt?: string; expiresAt: string },
): Promise<ProductionMandate> {
  const tenant = currentTenant();
  const operator = requireProductionOperator(tenant);
  const aggregateRef = planRef(planId);
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  return db().runTransaction(async (tx) => {
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(aggregateSnap.data());
    const immutableRevisionRef = revisionRef(planId, aggregate.currentRevision);
    const decisionRef = aggregateRef.collection("decisions").doc(`v${aggregate.currentRevision}`);
    const [revisionSnap, decisionSnap] = await Promise.all([tx.get(immutableRevisionRef), tx.get(decisionRef)]);
    if (aggregate.state !== "sealed") throw new Error(`cannot approve ${aggregate.state} production plan`);
    if (aggregate.currentPlanDigest !== input.planDigest) throw new Error("production plan changed before approval");
    if (decisionSnap.exists) throw new Error("production plan revision already decided");
    if (!revisionSnap.exists) throw new Error("production plan revision not found");
    const revision = assertRevision(revisionSnap.data());
    const mandate = createProductionMandate(revision.plan, {
      operatorSubjectId: operator.subjectId,
      authenticationId: operator.authenticationId,
      approvedAt,
      expiresAt: input.expiresAt,
    });
    tx.create(aggregateRef.collection("mandates").doc(mandate.id), mandate);
    tx.create(decisionRef, {
      decision: "approved",
      planDigest: input.planDigest,
      revision: aggregate.currentRevision,
      actorSubjectId: operator.subjectId,
      authenticationId: operator.authenticationId,
      decidedAt: approvedAt,
      mandateId: mandate.id,
    });
    for (const operation of revision.operations.filter((item) => item.executionAuthority === "production_mandate")) {
      const record = productionOutboxRecord(aggregate, operation, approvedAt);
      tx.create(productionOutboxRef(record.id), record);
    }
    tx.set(aggregateRef, {
      ...aggregate,
      state: "approved",
      activeMandateId: mandate.id,
      currentMandateReservedCostUsd: "0.000000",
      decidedAt: approvedAt,
      updatedAt: approvedAt,
    } satisfies ProductionPlanAggregate);
    return mandate;
  });
}

export async function rejectProductionPlan(
  planId: string,
  input: { planDigest: string; feedback: string; rejectedAt?: string },
): Promise<ProductionPlanAggregate> {
  const tenant = currentTenant();
  const operator = requireProductionOperator(tenant);
  const feedback = input.feedback.trim();
  if (!feedback) throw new Error("production plan rejection feedback required");
  const aggregateRef = planRef(planId);
  const rejectedAt = input.rejectedAt ?? new Date().toISOString();
  return db().runTransaction(async (tx) => {
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(aggregateSnap.data());
    if (aggregate.state !== "sealed") throw new Error(`cannot reject ${aggregate.state} production plan`);
    if (aggregate.currentPlanDigest !== input.planDigest) throw new Error("production plan changed before rejection");
    const decisionRef = aggregateRef.collection("decisions").doc(`v${aggregate.currentRevision}`);
    const decisionSnap = await tx.get(decisionRef);
    if (decisionSnap.exists) throw new Error("production plan revision already decided");
    tx.create(decisionRef, {
      decision: "rejected",
      planDigest: input.planDigest,
      revision: aggregate.currentRevision,
      actorSubjectId: operator.subjectId,
      authenticationId: operator.authenticationId,
      decidedAt: rejectedAt,
      feedback,
    });
    const updated: ProductionPlanAggregate = {
      ...aggregate,
      state: "rejected",
      activeMandateId: null,
      decidedAt: rejectedAt,
      updatedAt: rejectedAt,
    };
    tx.set(aggregateRef, updated);
    return updated;
  });
}

export async function claimPaidProductionOperation(
  planId: string,
  operationId: string,
  input: { claimToken: string },
): Promise<PaidProductionClaimOutcome> {
  const tenant = currentTenant();
  requireService(tenant);
  if (!input.claimToken) throw new Error("production operation claim token required");
  const aggregateRef = planRef(planId);
  return db().runTransaction(async (tx) => {
    const claimedAtDate = new Date();
    const claimedAt = claimedAtDate.toISOString();
    const claimedAtMs = claimedAtDate.getTime();
    const leaseExpiresAt = new Date(claimedAtMs + 5 * 60 * 1000).toISOString();
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(aggregateSnap.data());
    if (aggregate.state !== "approved" || !aggregate.activeMandateId) {
      throw new Error("active production mandate required");
    }
    const claimId = operationClaimId(aggregate.currentRevision, aggregate.currentPlanDigest, operationId);
    const claimRef = aggregateRef.collection("operation_claims").doc(claimId);
    const immutableRevisionRef = revisionRef(planId, aggregate.currentRevision);
    const mandateRef = aggregateRef.collection("mandates").doc(aggregate.activeMandateId);
    const [revisionSnap, mandateSnap, claimSnap] = await Promise.all([
      tx.get(immutableRevisionRef),
      tx.get(mandateRef),
      tx.get(claimRef),
    ]);
    if (!revisionSnap.exists || !mandateSnap.exists) throw new Error("production authorization aggregate is incomplete");
    const revision = assertRevision(revisionSnap.data());
    const mandate = productionMandateSchema.parse(mandateSnap.data());
    const operation = revision.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error("production operation not found in sealed graph");
    if (!operation.estimatedCostUsd) throw new Error("paid production operation has no sealed cost quote");
    const estimatedCostMicros = usdMicros(operation.estimatedCostUsd);
    if (estimatedCostMicros <= BigInt(0)) throw new Error("paid production operation cost must be positive");
    assertProductionMandateAuthorizes({
      mandate,
      plan: revision.plan,
      operation,
      activeMandateId: aggregate.activeMandateId,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
      now: new Date(mandate.approvedAt),
    });
    const existing = claimSnap.exists ? claimSnap.data() as PaidProductionOperationClaim : null;
    if (existing) {
      if (
        existing.planId !== planId
        || existing.planRevision !== aggregate.currentRevision
        || existing.planDigest !== aggregate.currentPlanDigest
        || existing.operationId !== operation.id
        || existing.requestDigest !== operation.requestDigest
        || existing.mandateId !== mandate.id
        || existing.reservedCostUsd !== operation.estimatedCostUsd
        || existing.pricingVersion !== revision.plan.pricingVersion
        || existing.workspaceId !== tenant.workspaceId
        || existing.brandId !== tenant.brandId
      ) throw new Error("production operation claim binding mismatch");
      if (existing.state === "succeeded") {
        return { outcome: "already_succeeded", claim: existing, operation };
      }
      if (existing.state === "failed" || existing.state === "uncertain") {
        return { outcome: existing.state, claim: existing, operation };
      }
      if (Date.parse(existing.leaseExpiresAt) > claimedAtMs) {
        return { outcome: "in_progress", claim: existing, operation };
      }
      if (
        (existing.state === "submitting" && !existing.providerOperationId)
        || (existing.provider === "lyria" && Boolean(existing.providerOperationId))
      ) {
        const uncertain: PaidProductionOperationClaim = {
          ...existing,
          state: "uncertain",
          failureReason: existing.provider === "lyria"
            ? "Lyria completed response cannot be resumed after worker lease expiry"
            : "provider submission may have occurred before worker lease expiry",
          failedAt: claimedAt,
          leaseExpiresAt: claimedAt,
        };
        tx.set(claimRef, uncertain);
        tx.set(productionOutboxRef(existing.id), { state: "completed", updatedAt: claimedAt }, { merge: true });
        return { outcome: "uncertain", claim: uncertain, operation };
      }
    }
    if (!existing?.providerOperationId) {
      assertProductionMandateAuthorizes({
        mandate,
        plan: revision.plan,
        operation,
        activeMandateId: aggregate.activeMandateId,
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        now: new Date(claimedAt),
      });
    }
    const alreadyReserved = usdMicros(aggregate.currentMandateReservedCostUsd);
    const nextReserved = existing ? alreadyReserved : alreadyReserved + estimatedCostMicros;
    if (nextReserved > usdMicros(mandate.maximumCostUsd)) {
      throw new Error("production mandate cost ceiling exceeded");
    }
    const claim: PaidProductionOperationClaim = {
      ...(existing ?? {}),
      kind: "paid",
      id: claimId,
      planId,
      jobId: revision.plan.jobId,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
      planRevision: aggregate.currentRevision,
      planDigest: aggregate.currentPlanDigest,
      operationId: operation.id,
      requestDigest: operation.requestDigest,
      mandateId: mandate.id,
      state: "claimed",
      reservedCostUsd: operation.estimatedCostUsd,
      pricingVersion: revision.plan.pricingVersion,
      claimTokenDigest: claimTokenDigest(input.claimToken),
      claimedAt,
      leaseExpiresAt,
      attempt: (existing?.attempt ?? 0) + 1,
    };
    if (claimSnap.exists) tx.set(claimRef, claim);
    else tx.create(claimRef, claim);
    if (!existing) tx.set(aggregateRef, {
      ...aggregate,
      currentMandateReservedCostUsd: microsUsd(nextReserved),
      updatedAt: claimedAt,
    } satisfies ProductionPlanAggregate);
    return { outcome: "execute", claim, operation };
  });
}

async function claimInternalProductionOperation(
  planId: string,
  operationId: string,
  input: { claimToken: string },
): Promise<Extract<ProductionClaimOutcome, { claim: InternalProductionOperationClaim }>> {
  const tenant = currentTenant();
  requireService(tenant);
  if (!input.claimToken) throw new Error("production operation claim token required");
  const aggregateRef = planRef(planId);
  return db().runTransaction(async (tx) => {
    const now = new Date();
    const claimedAt = now.toISOString();
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(aggregateSnap.data());
    if (aggregate.state !== "approved") throw new Error("approved production plan required");
    const revisionSnap = await tx.get(revisionRef(planId, aggregate.currentRevision));
    if (!revisionSnap.exists) throw new Error("production plan revision not found");
    const revision = assertRevision(revisionSnap.data());
    if (revision.planDigest !== aggregate.currentPlanDigest) throw new Error("production plan revision binding mismatch");
    const operation = revision.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error("production operation not found in sealed graph");
    if (operation.executionAuthority !== "internal") throw new Error("operation is not an internal production step");
    const claimId = operationClaimId(aggregate.currentRevision, aggregate.currentPlanDigest, operation.id);
    const claimRef = aggregateRef.collection("operation_claims").doc(claimId);
    const dependencyRefs = operation.dependsOn.map((dependencyId) => aggregateRef.collection("operation_claims").doc(
      operationClaimId(aggregate.currentRevision, aggregate.currentPlanDigest, dependencyId),
    ));
    const [claimSnap, ...dependencySnaps] = await Promise.all([
      tx.get(claimRef),
      ...dependencyRefs.map((ref) => tx.get(ref)),
    ]);
    const inputs: ProductionOperationInput[] = dependencySnaps.map((snapshot, index) => {
      if (!snapshot.exists) throw new Error(`production dependency is incomplete: ${operation.dependsOn[index]}`);
      const dependency = snapshot.data() as ProductionOperationClaim;
      if (dependency.state !== "succeeded" || !dependency.artifact) {
        throw new Error(`production dependency is incomplete: ${operation.dependsOn[index]}`);
      }
      return { operationId: operation.dependsOn[index], artifact: dependency.artifact };
    });
    const inputDigests = inputs.map((value) => ({ operationId: value.operationId, digest: value.artifact.digest }));
    const existing = claimSnap.exists ? claimSnap.data() as InternalProductionOperationClaim : null;
    if (existing) {
      if (
        existing.kind !== "internal"
        || existing.planId !== planId
        || existing.planRevision !== aggregate.currentRevision
        || existing.planDigest !== aggregate.currentPlanDigest
        || existing.operationId !== operation.id
        || existing.requestDigest !== operation.requestDigest
        || JSON.stringify(existing.inputDigests) !== JSON.stringify(inputDigests)
      ) throw new Error("internal production claim binding mismatch");
      if (existing.state === "succeeded") {
        return { outcome: "already_succeeded", claim: existing, operation, plan: revision.plan, inputs };
      }
      if (existing.state === "failed") {
        return { outcome: "failed", claim: existing, operation, plan: revision.plan, inputs };
      }
      if (Date.parse(existing.leaseExpiresAt) > now.getTime()) {
        return { outcome: "in_progress", claim: existing, operation, plan: revision.plan, inputs };
      }
    }
    const claim: InternalProductionOperationClaim = {
      kind: "internal",
      id: claimId,
      planId,
      jobId: revision.plan.jobId,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
      planRevision: aggregate.currentRevision,
      planDigest: aggregate.currentPlanDigest,
      operationId: operation.id,
      requestDigest: operation.requestDigest,
      state: "claimed",
      claimTokenDigest: claimTokenDigest(input.claimToken),
      claimedAt,
      leaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      attempt: (existing?.attempt ?? 0) + 1,
      inputDigests,
    };
    if (claimSnap.exists) tx.set(claimRef, claim);
    else tx.create(claimRef, claim);
    return { outcome: "execute", claim, operation, plan: revision.plan, inputs };
  });
}

export async function claimProductionOperation(
  planId: string,
  operationId: string,
  input: { claimToken: string },
): Promise<ProductionClaimOutcome> {
  const tenant = currentTenant();
  requireService(tenant);
  const aggregate = await getProductionPlan(planId);
  if (!aggregate) throw new Error("production plan not found");
  const revision = await getProductionPlanRevision(planId, aggregate.currentRevision);
  if (!revision) throw new Error("production plan revision not found");
  const operation = revision.operations.find((candidate) => candidate.id === operationId);
  if (!operation) throw new Error("production operation not found in sealed graph");
  return operation.executionAuthority === "production_mandate"
    ? claimPaidProductionOperation(planId, operationId, input)
    : claimInternalProductionOperation(planId, operationId, input);
}

export async function startProductionProviderSubmission(
  planId: string,
  operationId: string,
  input: { claimId: string; claimToken: string; provider: "veo" | "lyria" },
): Promise<PaidProductionOperationClaim> {
  const tenant = currentTenant();
  requireService(tenant);
  const aggregateRef = planRef(planId);
  return db().runTransaction(async (tx) => {
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(aggregateSnap.data());
    const claimRef = aggregateRef.collection("operation_claims").doc(checkedDocumentId("claim id", input.claimId));
    const claimSnap = await tx.get(claimRef);
    if (!claimSnap.exists) throw new Error("production operation claim not found");
    const claim = claimSnap.data() as PaidProductionOperationClaim;
    if (claim.kind !== "paid" || claim.operationId !== operationId) throw new Error("production operation claim binding mismatch");
    assertClaimOwner(claim, input.claimId, input.claimToken);
    if (claim.state === "submitting" && claim.provider === input.provider) return claim;
    if (claim.state !== "claimed") throw new Error(`production operation cannot submit from '${claim.state}'`);
    if (
      aggregate.state !== "approved"
      || aggregate.currentRevision !== claim.planRevision
      || aggregate.currentPlanDigest !== claim.planDigest
      || aggregate.activeMandateId !== claim.mandateId
    ) throw new Error("current production plan no longer authorizes this claimed revision");
    const [revisionSnap, mandateSnap] = await Promise.all([
      tx.get(revisionRef(planId, claim.planRevision)),
      tx.get(aggregateRef.collection("mandates").doc(claim.mandateId)),
    ]);
    if (!revisionSnap.exists || !mandateSnap.exists) throw new Error("production authorization aggregate is incomplete");
    const revision = assertRevision(revisionSnap.data());
    const mandate = productionMandateSchema.parse(mandateSnap.data());
    const operation = revision.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error("production operation not found in immutable revision");
    if (
      operation.requestDigest !== claim.requestDigest
      || operation.estimatedCostUsd !== claim.reservedCostUsd
      || revision.plan.pricingVersion !== claim.pricingVersion
    ) throw new Error("production operation claim binding mismatch");
    assertProductionMandateAuthorizes({
      mandate,
      plan: revision.plan,
      operation,
      activeMandateId: aggregate.activeMandateId,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
      now: new Date(),
    });
    const expectedProvider = operation.type === "generate_music" ? "lyria" : "veo";
    if (input.provider !== expectedProvider) throw new Error("provider does not match sealed production operation");
    const updated: PaidProductionOperationClaim = {
      ...claim,
      state: "submitting",
      provider: input.provider,
      submissionStartedAt: new Date().toISOString(),
    };
    tx.set(claimRef, updated);
    return updated;
  });
}

export async function recordProductionProviderOperation(
  planId: string,
  operationId: string,
  input: {
    claimId: string;
    claimToken: string;
    provider: "veo" | "lyria";
    providerOperationId: string;
    nextPollAt: string;
  },
): Promise<PaidProductionOperationClaim> {
  const tenant = currentTenant();
  requireService(tenant);
  if (!input.providerOperationId || input.providerOperationId.length > 2048) {
    throw new Error("invalid provider operation identity");
  }
  const nextPollAt = new Date(input.nextPollAt);
  if (Number.isNaN(nextPollAt.getTime())) throw new Error("invalid provider poll time");
  const aggregateRef = planRef(planId);
  return db().runTransaction(async (tx) => {
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    assertAggregate(aggregateSnap.data());
    const claimRef = aggregateRef.collection("operation_claims").doc(checkedDocumentId("claim id", input.claimId));
    const snap = await tx.get(claimRef);
    if (!snap.exists) throw new Error("production operation claim not found");
    const claim = snap.data() as PaidProductionOperationClaim;
    if (claim.kind !== "paid" || claim.operationId !== operationId) throw new Error("production operation claim binding mismatch");
    assertClaimOwner(claim, input.claimId, input.claimToken);
    if (claim.state !== "submitting" && claim.state !== "waiting_provider") {
      throw new Error(`production operation cannot wait for provider from '${claim.state}'`);
    }
    if (claim.providerOperationId && (
      claim.providerOperationId !== input.providerOperationId || claim.provider !== input.provider
    )) throw new Error("provider operation identity is immutable");
    const updated: PaidProductionOperationClaim = {
      ...claim,
      state: "waiting_provider",
      provider: input.provider,
      providerOperationId: input.providerOperationId,
      nextPollAt: nextPollAt.toISOString(),
      leaseExpiresAt: nextPollAt.toISOString(),
    };
    tx.set(claimRef, updated);
    tx.set(productionOutboxRef(claim.id), {
      state: "pending",
      availableAt: nextPollAt.toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
    return updated;
  });
}

export async function completePaidProductionOperation(
  planId: string,
  operationId: string,
  input: {
    claimId: string;
    claimToken: string;
    artifact: NonNullable<PaidProductionOperationClaim["artifact"]>;
    providerMetadata: Record<string, unknown>;
  },
): Promise<PaidProductionOperationClaim> {
  const tenant = currentTenant();
  requireService(tenant);
  if (!input.artifact) throw new Error("production artifact is required");
  const expectedPrefix = `durable-artifacts/${tenant.workspaceId}/${tenant.brandId}/production/`;
  if (!input.artifact.objectKey.startsWith(expectedPrefix) || input.artifact.objectKey.includes("..")) {
    throw new Error("production artifact is outside the tenant output prefix");
  }
  if (!/^[a-f0-9]{64}$/.test(input.artifact.digest) || !Number.isSafeInteger(input.artifact.sizeBytes) || input.artifact.sizeBytes < 1) {
    throw new Error("invalid production artifact identity");
  }
  const aggregateRef = planRef(planId);
  return db().runTransaction(async (tx) => {
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(aggregateSnap.data());
    const claimRef = aggregateRef.collection("operation_claims").doc(checkedDocumentId("claim id", input.claimId));
    const snap = await tx.get(claimRef);
    if (!snap.exists) throw new Error("production operation claim not found");
    const claim = snap.data() as PaidProductionOperationClaim;
    if (claim.kind !== "paid" || claim.operationId !== operationId) throw new Error("production operation claim binding mismatch");
    assertClaimOwner(claim, input.claimId, input.claimToken);
    if (claim.state === "succeeded") {
      if (JSON.stringify(claim.artifact) !== JSON.stringify(input.artifact)) {
        throw new Error("completed production artifact identity is immutable");
      }
      return claim;
    }
    if (claim.state !== "claimed" && claim.state !== "waiting_provider") {
      throw new Error(`production operation cannot complete from '${claim.state}'`);
    }
    if (!claim.provider || !claim.providerOperationId) {
      throw new Error("persisted provider identity is required before production completion");
    }
    const revisionSnap = await tx.get(revisionRef(planId, claim.planRevision));
    if (!revisionSnap.exists) throw new Error("production plan revision not found");
    const revision = assertRevision(revisionSnap.data());
    const operation = revision.operations.find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error("production operation not found in immutable revision");
    const expectedProvider = operation.type === "generate_music" ? "lyria" : "veo";
    const expectedMimePrefix = expectedProvider === "lyria" ? "audio/" : "video/";
    if (claim.provider !== expectedProvider || !input.artifact.mime.startsWith(expectedMimePrefix)) {
      throw new Error("production artifact does not match its sealed provider operation");
    }
    if (
      input.providerMetadata.provider !== claim.provider
      || input.providerMetadata.providerOperationId !== claim.providerOperationId
    ) throw new Error("production artifact provider metadata mismatch");
    const candidates = aggregate.state === "approved"
      && aggregate.currentRevision === claim.planRevision
      && aggregate.currentPlanDigest === claim.planDigest
      ? revision.operations.filter((candidate) => candidate.dependsOn.includes(operationId))
      : [];
    const otherDependencyIds = [...new Set(candidates.flatMap((candidate) => candidate.dependsOn)
      .filter((dependencyId) => dependencyId !== operationId))];
    const dependencySnaps = await Promise.all(otherDependencyIds.map((dependencyId) => tx.get(
      aggregateRef.collection("operation_claims").doc(operationClaimId(
        claim.planRevision, claim.planDigest, dependencyId,
      )),
    )));
    const dependencyStates = new Map(otherDependencyIds.map((dependencyId, index) => [
      dependencyId,
      dependencySnaps[index].exists ? (dependencySnaps[index].data() as ProductionOperationClaim).state : null,
    ]));
    const ready = candidates.filter((candidate) => candidate.dependsOn.every(
      (dependencyId) => dependencyId === operationId || dependencyStates.get(dependencyId) === "succeeded",
    ));
    const completedAt = new Date().toISOString();
    const updated: PaidProductionOperationClaim = {
      ...claim,
      state: "succeeded",
      artifact: input.artifact,
      providerMetadata: input.providerMetadata,
      completedAt,
      leaseExpiresAt: completedAt,
    };
    tx.set(claimRef, updated);
    tx.set(productionOutboxRef(claim.id), { state: "completed", updatedAt: completedAt }, { merge: true });
    for (const candidate of ready) {
      const record = productionOutboxRecord(aggregate, candidate, completedAt);
      tx.create(productionOutboxRef(record.id), record);
    }
    return updated;
  });
}

export async function completeInternalProductionOperation(
  planId: string,
  operationId: string,
  input: {
    claimId: string;
    claimToken: string;
    artifact: NonNullable<InternalProductionOperationClaim["artifact"]>;
    operationMetadata: Record<string, unknown>;
  },
): Promise<InternalProductionOperationClaim> {
  const tenant = currentTenant();
  requireService(tenant);
  const expectedPrefix = `durable-artifacts/${tenant.workspaceId}/${tenant.brandId}/production/`;
  if (!input.artifact.objectKey.startsWith(expectedPrefix) || input.artifact.objectKey.includes("..")) {
    throw new Error("production artifact is outside the tenant output prefix");
  }
  if (!/^[a-f0-9]{64}$/.test(input.artifact.digest) || !Number.isSafeInteger(input.artifact.sizeBytes) || input.artifact.sizeBytes < 1) {
    throw new Error("invalid production artifact identity");
  }
  const aggregateRef = planRef(planId);
  return db().runTransaction(async (tx) => {
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    const aggregate = assertAggregate(aggregateSnap.data());
    const claimRef = aggregateRef.collection("operation_claims").doc(checkedDocumentId("claim id", input.claimId));
    const claimSnap = await tx.get(claimRef);
    if (!claimSnap.exists) throw new Error("production operation claim not found");
    const claim = claimSnap.data() as InternalProductionOperationClaim;
    if (claim.kind !== "internal" || claim.operationId !== operationId) {
      throw new Error("internal production operation claim binding mismatch");
    }
    assertClaimOwner(claim, input.claimId, input.claimToken);
    if (claim.state === "succeeded") {
      if (JSON.stringify(claim.artifact) !== JSON.stringify(input.artifact)) {
        throw new Error("completed production artifact identity is immutable");
      }
      return claim;
    }
    if (claim.state !== "claimed") throw new Error(`internal production operation cannot complete from '${claim.state}'`);
    const revisionSnap = await tx.get(revisionRef(planId, claim.planRevision));
    if (!revisionSnap.exists) throw new Error("production plan revision not found");
    const revision = assertRevision(revisionSnap.data());
    const operation = revision.operations.find((candidate) => candidate.id === operationId);
    if (!operation || operation.executionAuthority !== "internal" || operation.requestDigest !== claim.requestDigest) {
      throw new Error("internal production operation revision binding mismatch");
    }
    const candidates = aggregate.state === "approved"
      && aggregate.currentRevision === claim.planRevision
      && aggregate.currentPlanDigest === claim.planDigest
      ? revision.operations.filter((candidate) => candidate.dependsOn.includes(operationId))
      : [];
    const otherDependencyIds = [...new Set(candidates.flatMap((candidate) => candidate.dependsOn)
      .filter((dependencyId) => dependencyId !== operationId))];
    const dependencySnaps = await Promise.all(otherDependencyIds.map((dependencyId) => tx.get(
      aggregateRef.collection("operation_claims").doc(operationClaimId(
        claim.planRevision, claim.planDigest, dependencyId,
      )),
    )));
    const dependencyStates = new Map(otherDependencyIds.map((dependencyId, index) => [
      dependencyId,
      dependencySnaps[index].exists ? (dependencySnaps[index].data() as ProductionOperationClaim).state : null,
    ]));
    const ready = candidates.filter((candidate) => candidate.dependsOn.every(
      (dependencyId) => dependencyId === operationId || dependencyStates.get(dependencyId) === "succeeded",
    ));
    const completedAt = new Date().toISOString();
    const updated: InternalProductionOperationClaim = {
      ...claim,
      state: "succeeded",
      artifact: input.artifact,
      operationMetadata: input.operationMetadata,
      completedAt,
      leaseExpiresAt: completedAt,
    };
    tx.set(claimRef, updated);
    tx.set(productionOutboxRef(claim.id), { state: "completed", updatedAt: completedAt }, { merge: true });
    for (const candidate of ready) {
      const record = productionOutboxRecord(aggregate, candidate, completedAt);
      tx.create(productionOutboxRef(record.id), record);
    }
    return updated;
  });
}

export async function completeProductionOperation(
  planId: string,
  operationId: string,
  input: {
    claimId: string;
    claimToken: string;
    artifact: NonNullable<ProductionOperationClaim["artifact"]>;
    operationMetadata: Record<string, unknown>;
  },
): Promise<ProductionOperationClaim> {
  const tenant = currentTenant();
  requireService(tenant);
  const aggregate = await getProductionPlan(planId);
  if (!aggregate) throw new Error("production plan not found");
  const claimSnap = await planRef(planId).collection("operation_claims")
    .doc(checkedDocumentId("claim id", input.claimId)).get();
  if (!claimSnap.exists) throw new Error("production operation claim not found");
  const claim = claimSnap.data() as ProductionOperationClaim;
  return claim.kind === "paid"
    ? completePaidProductionOperation(planId, operationId, {
      ...input,
      providerMetadata: input.operationMetadata,
    })
    : completeInternalProductionOperation(planId, operationId, input);
}

export async function recordProductionOperationFailure(
  planId: string,
  operationId: string,
  input: {
    claimId: string;
    claimToken: string;
    outcome: "failed" | "uncertain";
    reason: string;
  },
): Promise<ProductionOperationClaim> {
  const tenant = currentTenant();
  requireService(tenant);
  if (!input.reason || input.reason.length > 2000) throw new Error("invalid production failure reason");
  const aggregateRef = planRef(planId);
  return db().runTransaction(async (tx) => {
    const aggregateSnap = await tx.get(aggregateRef);
    if (!aggregateSnap.exists) throw new Error("production plan not found");
    assertAggregate(aggregateSnap.data());
    const claimRef = aggregateRef.collection("operation_claims").doc(checkedDocumentId("claim id", input.claimId));
    const snap = await tx.get(claimRef);
    if (!snap.exists) throw new Error("production operation claim not found");
    const claim = snap.data() as ProductionOperationClaim;
    if (claim.operationId !== operationId) throw new Error("production operation claim binding mismatch");
    assertClaimOwner(claim, input.claimId, input.claimToken);
    if (claim.state === input.outcome && claim.failureReason === input.reason) return claim;
    if (claim.kind === "internal" && input.outcome !== "failed") {
      throw new Error("cost-free internal production operations cannot have uncertain spend");
    }
    if (claim.state !== "claimed" && (claim.kind !== "paid" || (claim.state !== "submitting" && claim.state !== "waiting_provider"))) {
      throw new Error(`production operation cannot fail from '${claim.state}'`);
    }
    const failedAt = new Date().toISOString();
    const updated: ProductionOperationClaim = claim.kind === "paid" ? {
      ...claim,
      state: input.outcome,
      failureReason: input.reason,
      failedAt,
      leaseExpiresAt: failedAt,
    } : {
      ...claim,
      state: "failed",
      failureReason: input.reason,
      failedAt,
      leaseExpiresAt: failedAt,
    };
    tx.set(claimRef, updated);
    tx.set(productionOutboxRef(claim.id), { state: "completed", updatedAt: failedAt }, { merge: true });
    return updated;
  });
}

function assertProductionOutboxRecord(value: unknown): ProductionOperationOutboxRecord {
  if (!value || typeof value !== "object") throw new Error("invalid production outbox record");
  const record = value as ProductionOperationOutboxRecord;
  const tenant = currentTenant();
  if (record.workspaceId !== tenant.workspaceId || record.brandId !== tenant.brandId) {
    throw new Error("production outbox tenant mismatch");
  }
  checkedDocumentId("production outbox id", record.id);
  checkedDocumentId("production plan id", record.planId);
  checkedDocumentId("production job id", record.jobId);
  if (!Number.isSafeInteger(record.planRevision) || record.planRevision < 1) throw new Error("invalid production outbox revision");
  if (!/^[a-f0-9]{64}$/.test(record.planDigest)) throw new Error("invalid production outbox digest");
  if (!["pending", "publishing", "published", "completed", "superseded"].includes(record.state)) {
    throw new Error("invalid production outbox state");
  }
  return record;
}

export async function listDispatchableProductionOutbox(
  limit = 20,
  now = new Date(),
): Promise<ProductionOperationOutboxRecord[]> {
  const tenant = currentTenant();
  requireService(tenant);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid production outbox limit");
  const [readySnaps, abandonedSnaps] = await Promise.all([
    productionOutbox()
      .where("state", "in", ["pending", "published"])
      .where("availableAt", "<=", now.toISOString())
      .orderBy("availableAt", "asc")
      .limit(limit)
      .get(),
    productionOutbox()
      .where("state", "==", "publishing")
      .where("publishLeaseExpiresAt", "<=", now.toISOString())
      .orderBy("publishLeaseExpiresAt", "asc")
      .limit(limit)
      .get(),
  ]);
  const records = [...readySnaps.docs, ...abandonedSnaps.docs]
    .map((doc) => assertProductionOutboxRecord(doc.data()));
  return [...new Map(records.map((record) => [record.id, record])).values()]
    .sort((left, right) => Date.parse(
      left.state === "publishing" ? left.publishLeaseExpiresAt ?? left.updatedAt : left.availableAt,
    ) - Date.parse(
      right.state === "publishing" ? right.publishLeaseExpiresAt ?? right.updatedAt : right.availableAt,
    ))
    .slice(0, limit);
}

export type ProductionOutboxClaimResult =
  | { outcome: "publish"; record: ProductionOperationOutboxRecord }
  | { outcome: "in_progress" | "already_published"; record: ProductionOperationOutboxRecord };

export async function claimProductionOutbox(
  id: string,
  publishTokenDigest: string,
): Promise<ProductionOutboxClaimResult> {
  const tenant = currentTenant();
  requireService(tenant);
  if (!/^[a-f0-9]{64}$/.test(publishTokenDigest)) throw new Error("invalid production outbox publish token");
  const ref = productionOutboxRef(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("production outbox record not found");
    const record = assertProductionOutboxRecord(snap.data());
    if (["completed", "superseded"].includes(record.state)) {
      return { outcome: "already_published", record };
    }
    const now = new Date();
    if (record.state === "publishing" && Date.parse(record.publishLeaseExpiresAt ?? "") > now.getTime()) {
      return { outcome: "in_progress", record };
    }
    if ((record.state === "pending" || record.state === "published") && Date.parse(record.availableAt) > now.getTime()) {
      return { outcome: "in_progress", record };
    }
    const updated: ProductionOperationOutboxRecord = {
      ...record,
      state: "publishing",
      publishAttempt: record.publishAttempt + 1,
      publishTokenDigest,
      publishLeaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      updatedAt: now.toISOString(),
    };
    tx.set(ref, updated);
    return { outcome: "publish", record: updated };
  });
}

export async function finalizeProductionOutboxPublish(
  id: string,
  publishTokenDigest: string,
  pubsubMessageId: string,
): Promise<ProductionOperationOutboxRecord> {
  const tenant = currentTenant();
  requireService(tenant);
  const ref = productionOutboxRef(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("production outbox record not found");
    const record = assertProductionOutboxRecord(snap.data());
    if (record.state === "published" && record.pubsubMessageId === pubsubMessageId) return record;
    if (record.state !== "publishing" || record.publishTokenDigest !== publishTokenDigest) {
      throw new Error("production outbox publish ownership mismatch");
    }
    const now = new Date();
    const updated: ProductionOperationOutboxRecord = {
      ...record,
      state: "published",
      pubsubMessageId,
      availableAt: new Date(now.getTime() + 6 * 60 * 1000).toISOString(),
      updatedAt: now.toISOString(),
    };
    tx.set(ref, updated);
    return updated;
  });
}

export async function releaseProductionOutbox(id: string, publishTokenDigest: string): Promise<void> {
  const tenant = currentTenant();
  requireService(tenant);
  const ref = productionOutboxRef(id);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("production outbox record not found");
    const record = assertProductionOutboxRecord(snap.data());
    if (record.state !== "publishing" || record.publishTokenDigest !== publishTokenDigest) return;
    const { publishTokenDigest: _token, publishLeaseExpiresAt: _lease, ...released } = record;
    void _token;
    void _lease;
    tx.set(ref, {
      ...released,
      state: "pending",
      updatedAt: new Date().toISOString(),
    });
  });
}
