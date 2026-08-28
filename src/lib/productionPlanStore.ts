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
  state: "claimed";
  reservedCostUsd: string;
  claimTokenDigest: string;
  claimedAt: string;
  leaseExpiresAt: string;
  attempt: number;
}

export type PaidProductionClaimOutcome = {
  outcome: "execute" | "in_progress";
  claim: PaidProductionOperationClaim;
};

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

function plans() {
  const tenant = currentTenant();
  return db().collection("workspaces").doc(tenant.workspaceId)
    .collection("brands").doc(tenant.brandId).collection("production_plans");
}

function planRef(planId: string) {
  return plans().doc(checkedDocumentId("production plan id", planId));
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
  const digest = productionPlanDigest(plan);
  const revision: ProductionPlanRevision = {
    revision: plan.revision,
    plan,
    planDigest: digest,
    operations: compileProductionOperations(plan),
    proposedAt,
  };
  return db().runTransaction(async (tx) => {
    const [aggregateSnap, revisionSnap, jobSnap] = await Promise.all([
      tx.get(aggregateRef),
      tx.get(immutableRevisionRef),
      tx.get(jobRef),
    ]);
    if (!jobSnap.exists) throw new Error("production plan job not found");
    if (jobSnap.get("workspaceId") !== tenant.workspaceId || jobSnap.get("brandId") !== tenant.brandId) {
      throw new Error("production plan job tenant mismatch");
    }
    if (revisionSnap.exists) throw new Error(`production plan revision ${plan.revision} already exists`);
    const existing = aggregateSnap.exists ? assertAggregate(aggregateSnap.data()) : null;
    const expectedRevision = existing ? existing.currentRevision + 1 : 1;
    if (plan.revision !== expectedRevision) throw new Error(`expected production plan revision ${expectedRevision}`);
    if (existing && existing.jobId !== plan.jobId) throw new Error("production plan job cannot change");
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
    const claimId = createHash("sha256").update(
      `${aggregate.currentRevision}\n${aggregate.currentPlanDigest}\n${operationId}`,
    ).digest("hex");
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
      now: new Date(claimedAt),
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
        || existing.workspaceId !== tenant.workspaceId
        || existing.brandId !== tenant.brandId
      ) throw new Error("production operation claim binding mismatch");
      if (Date.parse(existing.leaseExpiresAt) > claimedAtMs) {
        return { outcome: "in_progress", claim: existing };
      }
    }
    const alreadyReserved = usdMicros(aggregate.currentMandateReservedCostUsd);
    const nextReserved = existing ? alreadyReserved : alreadyReserved + estimatedCostMicros;
    if (nextReserved > usdMicros(mandate.maximumCostUsd)) {
      throw new Error("production mandate cost ceiling exceeded");
    }
    const claim: PaidProductionOperationClaim = {
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
      claimTokenDigest: createHash("sha256").update(input.claimToken).digest("hex"),
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
    return { outcome: "execute", claim };
  });
}
