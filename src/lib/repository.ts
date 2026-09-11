import { revokeSourceKnowledge, revokeWorkspaceKnowledge } from "./sourceKnowledgeErasure";
import { createHash } from "node:crypto";
import { chatScopeKey,retentionPlan,type ChatSurface } from "./chatHistory";
import { parseBudgetConfig } from "./config";
import { decideConnectionRefresh,type ConnectionRefreshState } from "./connectionRefresh";
import { agentActivitySchema } from "./contracts";
import { markReservationFinalized,markReservationReleased,markReservationUncertain,type CostReservationState } from "./costReservations";
import { applyFinalizedUsage,applyReleasedReservation,applyReservation,canReserve,exceedsApprovalThreshold } from "./costs";
import type { ApprovalActor } from "./decisions";
import { requireWorkspaceAdministrator } from "./authority";
import { authorizeJobRetry } from "./jobRetry";
import { isKnownStage } from "./stages";
import { INTERNAL_CONTRACT_REVISION } from "./internalHandler";
import { PermanentRetryConflict, permanentRetryRequestSchema, type PermanentRetryAuthorization, type PermanentRetryRequest } from "./permanentRetry";
import { awsRepository,DynamoTransaction,field,limited,newRecordId,ordered,partition,recordKey,REMOVE_FIELD,StoredRecord,where } from "./dynamo";
import { assertEditorialPlanSubmission,assertSelectedProductionAuthority,editorialPlanDigest,editorialPlanEvidenceLineage,editorialPlanningSnapshotDigest,isMatchingActiveProduction } from "./editorialPlan";
import { buildEditorialPlanningSnapshot } from "./editorialPlanning";
import { authorityKey, listPlanningAssets, readItemState, readPlan, readPlannedItem, readPlanningPolicy } from "./campaigns/repository";
import { persistEditorialPlan } from "./campaigns/editorial";
import { claimNextPlannedItem, plannedItemAdmission, reconcilePlannedExecution } from "./planning/selection";
import { decideEffectClaim,decideEffectFinalization } from "./effectClaims";
import type { EventInboxClaimResult,EventInboxRecord } from "./eventInbox";
import { EventInboxStore,type DurableEventClaimInput } from "./eventInboxStore";
import { actionPayloadDigest,newId } from "./idempotency";
import { deletionTombstone,retentionDeadline,type DeletionPlan,type WorkspaceDeletionPlan } from "./lifecycle";
import {
DynamoOperationPersistence,
OperationStore,
type OperationRecoveryPage,
} from "./operationStore";
import {
operationIdForStage,
operationIdForStageGeneration,
type CreateOperationInput,
type FinalizeOperationInput,
type OperationClaimInput,
type OperationClaimResult,
type OperationFence,
type OperationRecord,
} from "./operations";
import { decideWorkAdmission } from "./operations/workAdmission";
import { canonicalJson } from "./recordReplay/integrity";
import { omitUndefinedFields } from "./recordValues";
import { connectionEnvelopeKey,decryptSecret,encryptSecret,type SecretEnvelope } from "./secretEnvelope";
import { claimStageExecution as decideStageClaim,finalizeStageExecution,type StageClaimResult,type StageExecution } from "./stageExecutions";
import {
decideStageOutboxClaim,
finalizeStageOutbox,
normalizeStageOutboxRecord,
releaseStageOutboxClaim,
type StageOutboxRecord,
} from "./stageOutbox";
import { deleteArtifactUri,deleteWorkspaceArtifactUri } from "./storage";
import { assertStrategyProposalRevision,strategyDigest,strategySourceEvidenceIds,validatePersistedStrategy,validateStrategySearchGrounding,type StrategyDecisionInput } from "./strategyApproval";
import { decideStrategyProposal, insertStrategyProposal, readActiveStrategyRef } from "./strategy/repository";
import { resolveJobStrategy } from "./strategy/context";
import { assertJobSourceBinding } from "./strategy/sourceBinding";
import { decideTelegramNonceClaim,telegramDigest,type TelegramWebhookRoute } from "./telegramWebhook";
import { currentTraceId } from "./telemetry";
import {
assertResourceWorkspace,
currentTenant,
tenantCollectionPath,
tenantSubjectId,
} from "./tenancy";
import { decideTickClaim,type TickClaimState } from "./tickClaims";
import type {
ApprovalDecision,
EffectClaim,
EffectClaimInput,
EffectClaimOutcome,
Engagement,
EvidencePacket,
Job,
JobBudget,
JobConfig,
Learnings,
PlannedAction,
Receipt,
ReplayObservation,
Stage,
StageEvent,
UsageRecord,
VerificationResult,
} from "./types";

export const db = awsRepository;

function durableOperations(): OperationStore {
  return new OperationStore(new DynamoOperationPersistence(db()));
}

function durableEvents(): EventInboxStore {
  return new EventInboxStore(db());
}

export function claimDurableEvent(input: DurableEventClaimInput): Promise<EventInboxClaimResult> {
  return durableEvents().claim(input);
}

export function getDurableEvent(source: string, sourceEventId: string): Promise<EventInboxRecord | null> {
  return durableEvents().get(source, sourceEventId);
}

export function completeDurableEvent(
  source: string,
  sourceEventId: string,
  input: {
    ownerTokenDigest: string;
    outcome: "completed" | "rejected";
    now: string;
    rejectionReason?: string;
    operationId: string;
    operationEpoch: number;
    operationState: "unknown" | "succeeded" | "failed" | "cancelled";
    operationReason?: string;
  },
): Promise<EventInboxRecord> {
  return durableEvents().complete(source, sourceEventId, input);
}

export function createDurableOperation(
  input: CreateOperationInput,
): Promise<{ created: boolean; operation: OperationRecord }> {
  return durableOperations().create(input);
}

export function getDurableOperation(operationId: string): Promise<OperationRecord | null> {
  return durableOperations().get(operationId);
}

export function claimDurableOperation(
  operationId: string,
  input: OperationClaimInput,
): Promise<OperationClaimResult> {
  return durableOperations().claim(operationId, input);
}

export function assertDurableOperationFence(fence: OperationFence): Promise<OperationRecord> {
  return durableOperations().assertFence(fence);
}

export function finalizeDurableOperation(
  operationId: string,
  input: FinalizeOperationInput,
): Promise<OperationRecord> {
  return durableOperations().finalize(operationId, input);
}

export function listDurableOperationRecoveryCandidates(input: {
  now: string;
  limit: number;
  cursor?: { leaseExpiresAt: string; id: string };
}): Promise<OperationRecoveryPage> {
  return durableOperations().listRecoveryCandidates(input);
}

export interface WorkspaceScopeDoc {
  workspaceId: string;
  brandId: string;
}

export async function listWorkspaceScopes(): Promise<WorkspaceScopeDoc[]> {
  const snaps = await awsRepository().query(partition("workspaces"));
  return snaps.rows
    .filter((doc) => !field(doc.value, "disabledAt"))
    .map((doc) => ({
      workspaceId: doc.id,
      brandId: String(field(doc.value, "defaultBrandId") ?? ""),
    }))
    .filter((scope) => Boolean(scope.brandId));
}

interface JobDoc extends Omit<Job, "id"> {
  actions?: PlannedAction[];
  verifications?: VerificationResult[];
  packet?: EvidencePacket;
  budget?: JobBudget;
}

const JOBS = "jobs";
const EVENTS = "events";
const EVENT_LOG = "event_log";
const RECEIPTS = "receipts";
const APPROVAL_DECISIONS = "approval_decisions";
const REPLAY_OBSERVATIONS = "replay_observations";
const EFFECT_CLAIMS = "effect_claims";
const ASSETS = "assets";
const CONFIG = "config";
const CONNECTIONS = "connections";
const CONTENT_ITEMS = "content_items";
const NOTIFICATIONS = "notifications";
const PROPOSALS = "proposals";
const COST_RESERVATIONS = "cost_reservations";
const USAGE_RECORDS = "usage_records";
const MEDIA_OPERATIONS = "media_operations";
const STAGE_EXECUTIONS = "stage_executions";
const DELETION_TOMBSTONES = "deletion_tombstones";
const STAGE_OUTBOX = "stage_outbox";

function tenantCollection(name: string) {
  return partition(tenantCollectionPath(currentTenant(), name));
}

function initialJobBudget(): JobBudget {
  const config = parseBudgetConfig(process.env);
  return {
    estimatedUsd: "0.00",
    observedUsd: "0.00",
    reservedUsd: "0.00",
    limitUsd: config.DEFAULT_JOB_BUDGET_USD,
    approvalThresholdUsd: config.DEFAULT_JOB_APPROVAL_THRESHOLD_USD,
  };
}

function stageOutboxId(jobId: string, stage: Stage, attempt: number): string {
  return createHash("sha256").update(`${jobId}:${stage}:${attempt}`).digest("hex");
}

function stageOutboxDurability(
  id: string,
  jobId: string,
  stage: Stage,
  generation: number,
  completedStage?: Stage,
): Pick<StageOutboxRecord, "schemaVersion" | "sourceEventId" | "operationId" | "correlationId" | "causationId" | "publishAttempt"> {
  return {
    schemaVersion: 1,
    sourceEventId: `stage-outbox:${id}`,
    operationId: operationIdForStageGeneration(jobId, stage, generation),
    correlationId: `job:${jobId}`,
    ...(completedStage ? { causationId: operationIdForStage(jobId, completedStage) } : {}),
    publishAttempt: 0,
  };
}

function stageOutboxRef(id: string) {
  return recordKey(tenantCollection(STAGE_OUTBOX).partition + "/" + id);
}

export function createStageOutboxInTransaction(
  transaction: DynamoTransaction,
  jobId: string,
  stage: Stage,
  attempt: number,
  metadata: { completedStage?: Stage; note?: string } = {},
): string {
  const id = stageOutboxId(jobId, stage, attempt);
  const tenant = currentTenant();
  transaction.insert(stageOutboxRef(id), {
    id,
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    jobId,
    stage,
    attempt,
    ...metadata,
    ...stageOutboxDurability(id, jobId, stage, attempt, metadata.completedStage),
    state: "pending",
    createdAt: new Date().toISOString(),
  } satisfies StageOutboxRecord);
  return id;
}

export async function enqueueStageTrigger(
  jobId: string,
  stage: Stage,
  attempt = 0,
  metadata: { completedStage?: Stage; note?: string } = {},
): Promise<string> {
  const id = stageOutboxId(jobId, stage, attempt);
  const ref = stageOutboxRef(id);
  const tenant = currentTenant();
  await db().atomic(async (tx) => {
    const [jobSnapshot, existing] = await Promise.all([tx.read(jobRef(jobId)), tx.read(ref)]);
    const job = requireJobDoc(jobSnapshot);
    if (job.stage !== stage) throw new Error(`cannot enqueue stage '${stage}' while job is '${job.stage}'`);
    if (existing.present) return;
    tx.insert(ref, {
      id, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
      jobId, stage, attempt, ...metadata,
      ...stageOutboxDurability(id, jobId, stage, attempt, metadata.completedStage),
      state: "pending", createdAt: new Date().toISOString(),
    } satisfies StageOutboxRecord);
  });
  return id;
}

export async function transitionStageWithOutbox(
  jobId: string,
  completedStage: Stage,
  nextStage: Stage,
  note: string,
): Promise<string> {
  const tenant = currentTenant();
  return db().atomic(async (tx) => {
    const jobSnapshot = await tx.read(jobRef(jobId));
    const job = requireJobDoc(jobSnapshot);
    if (job.stage === nextStage) {
      const currentId = stageOutboxId(jobId, nextStage, job.controlEpoch);
      if ((await tx.read(stageOutboxRef(currentId))).present) return currentId;
      throw new Error(`stage '${nextStage}' has no durable outbox for generation ${job.controlEpoch}`);
    }
    const generation = job.controlEpoch + 1;
    const id = stageOutboxId(jobId, nextStage, generation);
    const ref = stageOutboxRef(id);
    const existing = await tx.read(ref);
    if (existing.present) return id;
    if (job.stage !== completedStage) {
      throw new Error(`cannot complete stage '${completedStage}' while job is '${job.stage}'`);
    }
    tx.patch(jobRef(jobId), {
      stage: nextStage,
      status: "running",
      controlEpoch: generation,
      controlState: "running",
      updatedAt: new Date().toISOString(),
    });
    tx.insert(ref, {
      id, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
      jobId, stage: nextStage, attempt: 0, completedStage, note,
      ...stageOutboxDurability(id, jobId, nextStage, generation, completedStage),
      state: "pending", createdAt: new Date().toISOString(),
    } satisfies StageOutboxRecord);
    return id;
  });
}
export async function listDispatchableStageOutbox(limit = 20): Promise<StageOutboxRecord[]> {
  const tenant = currentTenant();
  const snapshot = await awsRepository().query(limited(where(tenantCollection(STAGE_OUTBOX), "state", "in", ["pending", "claimed"]), 100));
  return snapshot.rows
    .map((doc) => doc.value as unknown as StageOutboxRecord)
    .filter((record) => record.workspaceId === tenant.workspaceId && record.brandId === tenant.brandId)
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export async function claimStageOutbox(
  id: string,
  claimTokenDigest: string,
  now = new Date(),
): Promise<ReturnType<typeof decideStageOutboxClaim>> {
  const ref = stageOutboxRef(id);
  return db().atomic(async (tx) => {
    const snapshot = await tx.read(ref);
    if (!snapshot.present) throw new Error("stage outbox record not found");
    const record = normalizeStageOutboxRecord(snapshot.value as unknown as StageOutboxRecord);
    assertResourceWorkspace(currentTenant(), record);
    const decision = decideStageOutboxClaim(record, claimTokenDigest, now);
    if (decision.outcome === "publish") tx.put(ref, decision.record);
    return decision;
  });
}

export async function releaseStageOutbox(
  id: string,
  claimTokenDigest: string,
): Promise<void> {
  const ref = stageOutboxRef(id);
  await db().atomic(async (tx) => {
    const snapshot = await tx.read(ref);
    if (!snapshot.present) return;
    const record = normalizeStageOutboxRecord(snapshot.value as unknown as StageOutboxRecord);
    assertResourceWorkspace(currentTenant(), record);
    tx.put(ref, releaseStageOutboxClaim(record, claimTokenDigest));
  });
}

export async function finalizeStageOutboxPublish(
  id: string,
  claimTokenDigest: string,
  transportMessageId: string,
  now = new Date(),
): Promise<void> {
  const ref = stageOutboxRef(id);
  await db().atomic(async (tx) => {
    const snapshot = await tx.read(ref);
    if (!snapshot.present) throw new Error("stage outbox record not found");
    const current = normalizeStageOutboxRecord(snapshot.value as unknown as StageOutboxRecord);
    assertResourceWorkspace(currentTenant(), current);
    const finalized = finalizeStageOutbox(current, claimTokenDigest, transportMessageId, now);
    tx.put(ref, finalized);
    if (current.completedStage && current.note) {
      const event = {
        jobId: current.jobId,
        at: new Date().toISOString(),
        stage: current.completedStage,
        message: current.note,
        actor: "system" as const,
        operationId: `${current.jobId}:${current.completedStage}:${id}`,
        traceId: currentTraceId(),
        transportMessageId,
      };
      tx.put(recordKey(partition(jobRef(current.jobId).path + "/" + EVENTS).partition + "/" + `outbox-${id}`), event);
      tx.put(recordKey(tenantCollection(EVENT_LOG).partition + "/" + `outbox-${id}`), event);
    }
  });
}

// ---------- content items ----------

export function contentItemRef(id: string) {
  return recordKey(tenantCollection(CONTENT_ITEMS).partition + "/" + id);
}

export async function createContentItem(item: import("./types").ContentItem): Promise<void> {
  await awsRepository().put(contentItemRef(item.id), item);
}

export async function getContentItem(id: string) {
  const snap = await awsRepository().read(contentItemRef(id));
  return snap.present ? (snap.value as unknown as import("./types").ContentItem) : null;
}

export async function updateContentItem(
  id: string,
  patch: Partial<import("./types").ContentItem>,
): Promise<void> {
  // Callers use `undefined` fields (e.g. failureReason) to clear values, but
  // DynamoRepository rejects undefined — strip them so merges stay valid.
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  await awsRepository().put(contentItemRef(id), { ...clean, updatedAt: new Date().toISOString() }, { merge: true });
}

export function deleteRecordField(): symbol {
  return REMOVE_FIELD;
}

export async function saveCalendarSyncIfUnchanged(
  id: string,
  expectedUpdatedAt: string,
  sync: import("./types").GoogleCalendarSync,
): Promise<import("./types").GoogleCalendarSync> {
  const ref = contentItemRef(id);
  return db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) throw new Error("content item disappeared during calendar synchronization");
    const current = snap.value as unknown as import("./types").ContentItem;
    const persisted = current.updatedAt === expectedUpdatedAt || sync.status === "removed"
      ? sync
      : { ...sync, status: "update_required" as const };
    tx.put(ref, { googleCalendarSync: persisted, updatedAt: new Date().toISOString() }, { merge: true });
    return persisted;
  });
}

export async function listContentItems(): Promise<import("./types").ContentItem[]> {
  const snaps = await awsRepository().query(limited(ordered(tenantCollection(CONTENT_ITEMS), "createdAt", "desc"), 200));
  return snaps.rows.map((d) => d.value as unknown as import("./types").ContentItem);
}

export async function getOrCreateEditorialPlanningSnapshot(jobId: string) {
  const job = await getJob(jobId);
  const revision = job.editorialPlanRevision ?? 1;
  const expectedId = `planning-${jobId}-v${revision}`;
  if (job.editorialPlanningSnapshot?.snapshotId === expectedId && job.editorialPlanningSnapshotDigest) {
    assertJobSourceBinding(job, job.editorialPlanningSnapshot);
    if (editorialPlanningSnapshotDigest(job.editorialPlanningSnapshot) !== job.editorialPlanningSnapshotDigest) {
      throw new Error("persisted editorial planning snapshot digest mismatch");
    }
    return { snapshot: job.editorialPlanningSnapshot, digest: job.editorialPlanningSnapshotDigest };
  }
  const policy = await readPlanningPolicy();
  const assets = await listPlanningAssets();
  const { plannedCalendar } = await import("./planning/commands");
  const { readItemState } = await import("./campaigns/repository");
  const planned = await plannedCalendar();
  const blockedDependencies: import("./types").EditorialPlanningSnapshot["blockedDependencies"] = [];
  for (const item of planned) for (const dependency of item.dependencies) {
    const state = await readItemState(dependency);
    if (state.status !== "completed") blockedDependencies.push({ id: dependency.id, briefId: item.editorialItemId ?? item.ref.id, reason: `Dependency is ${state.status}`, evidenceRefs: [`planned-item:${dependency.id}:v${dependency.revision}`] });
  }
  const plannedExecutionIds = new Set(planned.map(item => item.lifecycle.jobId).filter(Boolean));
  const candidate = buildEditorialPlanningSnapshot(job, (await listContentItems()).filter(item => !plannedExecutionIds.has(item.jobId)), new Date().toISOString(), {
    policy, assetReadiness: assets.map(({ id, briefId, assetType, status, evidenceRefs }) => ({ id, briefId, assetType, status, evidenceRefs })), blockedDependencies,
    plannedCommitments: planned.map(item => ({ id: `planned:${item.ref.id}`, channel: item.channel, publicationWindowStartAt: item.scheduledFor, publicationWindowEndAt: item.publicationWindowEndAt ?? new Date(Date.parse(item.scheduledFor) + 3600000).toISOString() })),
  });
  const digest = editorialPlanningSnapshotDigest(candidate);
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.read(ref);
    const current = await resolveJobStrategy(requireJobDoc(snap), tx);
    const currentPolicy = await readPlanningPolicy(tx);
    if (strategyDigest(currentPolicy.ref) !== strategyDigest(policy.ref) || strategyDigest(await listPlanningAssets(tx)) !== strategyDigest(assets) || strategyDigest(await plannedCalendar(tx)) !== strategyDigest(planned)) throw new Error("planning calendar or policy changed while snapshot was assembled");
    assertJobSourceBinding(current, candidate);
    if ((current.editorialPlanRevision ?? 1) !== revision || current.strategyDigest !== job.strategyDigest) {
      throw new Error("editorial planning authority changed while snapshot was assembled");
    }
    if (current.editorialPlanningSnapshot?.snapshotId === expectedId && current.editorialPlanningSnapshotDigest) {
      assertJobSourceBinding(current, current.editorialPlanningSnapshot);
      if (editorialPlanningSnapshotDigest(current.editorialPlanningSnapshot) !== current.editorialPlanningSnapshotDigest) {
        throw new Error("persisted editorial planning snapshot digest mismatch");
      }
      return { snapshot: current.editorialPlanningSnapshot, digest: current.editorialPlanningSnapshotDigest };
    }
    if (current.stage !== "plan") throw new Error("job is not in editorial planning stage");
    tx.patch(ref, {
      editorialPlanningSnapshot: candidate,
      editorialPlanningSnapshotDigest: digest,
      [`editorialPlanningSnapshotHistory.v${revision}`]: {
        snapshot: candidate, digest, revision, capturedAt: candidate.asOf,
      },
      updatedAt: new Date().toISOString(),
    });
    return { snapshot: candidate, digest };
  });
}

// ---------- notifications ----------

export async function createNotification(n: import("./types").AppNotification): Promise<void> {
  const id = n.id ?? newId();
  await awsRepository().put(recordKey(tenantCollection(NOTIFICATIONS).partition + "/" + id), { ...n, id, createdAt: n.createdAt || new Date().toISOString() });
}

export async function listNotifications(limit = 100): Promise<import("./types").AppNotification[]> {
  const snaps = await awsRepository().query(limited(ordered(tenantCollection(NOTIFICATIONS), "createdAt", "desc"), limit));
  return snaps.rows.map((d) => d.value as unknown as import("./types").AppNotification);
}

export async function markNotificationRead(id: string): Promise<void> {
  await awsRepository().patch(recordKey(tenantCollection(NOTIFICATIONS).partition + "/" + id), { readAt: new Date().toISOString() });
}

export async function markAllNotificationsRead(): Promise<void> {
  const snaps = await awsRepository().query(where(tenantCollection(NOTIFICATIONS), "readAt", "==", null));
  await Promise.all(snaps.rows.map((d) => awsRepository().patch(d.key, { readAt: new Date().toISOString() })));
}

// ---------- proactive content proposals ----------

export interface ContentProposal {
  id: string;
  source: "trend_scan" | "engagement_watch" | "calendar_gap" | "recycle";
  topic: string;
  angle: string;
  reason: string;
  sources: string[];
  suggestedPost: string;
  status: "proposed" | "approved" | "rejected";
  jobId?: string;
  createdAt: string;
  decidedAt?: string;
}

function proposalRef(id: string) {
  return recordKey(tenantCollection(PROPOSALS).partition + "/" + id);
}

export async function getProposal(id: string): Promise<ContentProposal | null> {
  const snap = await awsRepository().read(proposalRef(id));
  return snap.present ? (snap.value as unknown as ContentProposal) : null;
}

export async function saveProposal(p: ContentProposal): Promise<void> {
  await awsRepository().put(proposalRef(p.id), p);
}

export async function listProposals(limit = 100): Promise<ContentProposal[]> {
  const snaps = await awsRepository().query(limited(ordered(tenantCollection(PROPOSALS), "createdAt", "desc"), limit));
  return snaps.rows.map((d) => d.value as unknown as ContentProposal);
}

export async function decideProposal(
  id: string,
  decision: "approved" | "rejected",
  patch: { jobId?: string } = {},
): Promise<void> {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await awsRepository().put(proposalRef(id), { status: decision, decidedAt: new Date().toISOString(), ...clean }, { merge: true });
}

// ---------- agent state (proactive check cadence bookkeeping) ----------

const AGENT_STATE = "agent_state";

export interface AgentStateDoc {
  lastRunAt?: string;
  data?: Record<string, unknown>;
  updatedAt: string;
}

export async function getAgentState(key: string): Promise<AgentStateDoc | null> {
  const snap = await awsRepository().read(recordKey(tenantCollection(AGENT_STATE).partition + "/" + key));
  return snap.present ? (snap.value as unknown as AgentStateDoc) : null;
}

export async function setAgentState(key: string, patch: Partial<AgentStateDoc>): Promise<void> {
  await awsRepository().put(recordKey(tenantCollection(AGENT_STATE).partition + "/" + key), { ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function claimAgentTick(
  key: string,
  claimId: string,
  leaseSeconds: number,
  now = new Date(),
): Promise<boolean> {
  const ref = recordKey(tenantCollection(AGENT_STATE).partition + "/" + key);
  return db().atomic(async (tx) => {
    const snapshot = await tx.read(ref);
    const current = snapshot.present && field(snapshot.value, "claimId") ? {
      claimId: String(field(snapshot.value, "claimId")),
      claimedAt: String(field(snapshot.value, "claimedAt")),
      leaseUntil: String(field(snapshot.value, "leaseUntil")),
    } satisfies TickClaimState : null;
    const decision = decideTickClaim(current, claimId, leaseSeconds, now);
    if (!decision.claimed) return false;
    tx.put(ref, {
      ...decision.state,
      updatedAt: now.toISOString(),
    }, { merge: true });
    return true;
  });
}

export interface ConnectionDoc {
  platform: string;
  mode: "oauth" | "manual" | "env";
  handle?: string;
  accountId?: string;
  scopes?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  connectedAt: string;
  credentialRevision?: number;
  health?: "active" | "reconnect_required" | "revocation_pending";
  destinations?: import("./publishing/contracts").PublishDestination[];
  defaultDestinationId?: string;
  calendarId?: string;
  calendarTitle?: string;
  calendarProvisionedAt?: string;
  calendarProvisioning?: { status: "claimed" | "uncertain"; claimId: string; at: string };
}

type StoredConnectionDoc = Omit<ConnectionDoc, "accessToken" | "refreshToken"> & {
  accessTokenEnvelope: SecretEnvelope;
  refreshTokenEnvelope?: SecretEnvelope;
  tokenRefresh?: ConnectionRefreshState;
};

function connectionAad(platform: string): string {
  return `${currentTenant().workspaceId}:${platform}`;
}

function decodeConnection(stored: StoredConnectionDoc): ConnectionDoc {
  const key = connectionEnvelopeKey();
  const { accessTokenEnvelope, refreshTokenEnvelope, tokenRefresh: _tokenRefresh, ...metadata } = stored;
  return {
    ...metadata,
    accessToken: decryptSecret(accessTokenEnvelope, key, `${connectionAad(stored.platform)}:access`),
    refreshToken: refreshTokenEnvelope
      ? decryptSecret(refreshTokenEnvelope, key, `${connectionAad(stored.platform)}:refresh`)
      : undefined,
  };
}

function encodeConnection(connection: ConnectionDoc, tokenRefresh?: ConnectionRefreshState): StoredConnectionDoc {
  const key = connectionEnvelopeKey();
  const { accessToken, refreshToken, ...metadata } = connection;
  return {
    ...omitUndefinedFields(metadata),
    accessTokenEnvelope: encryptSecret(accessToken, key, `${connectionAad(connection.platform)}:access`),
    ...(refreshToken
      ? { refreshTokenEnvelope: encryptSecret(refreshToken, key, `${connectionAad(connection.platform)}:refresh`) }
      : {}),
    ...(tokenRefresh ? { tokenRefresh } : {}),
  };
}

export async function claimCalendarProvisioning(): Promise<{ calendarId?: string; claimId?: string }> {
  const ref = connectionRef("google-calendar");
  return db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) throw new Error("Google Calendar is not connected");
    const connection = snap.value as unknown as ConnectionDoc;
    if (connection.calendarId) return { calendarId: connection.calendarId };
    if (connection.calendarProvisioning) {
      throw new Error(connection.calendarProvisioning.status === "uncertain"
        ? "Calendar provisioning outcome is uncertain; inspect Google Calendar before reconnecting"
        : "Calendar provisioning is already in progress");
    }
    const claimId = newId();
    tx.put(ref, { calendarProvisioning: { status: "claimed", claimId, at: new Date().toISOString() } }, { merge: true });
    return { claimId };
  });
}

export async function completeCalendarProvisioning(claimId: string, calendar: { id: string; summary: string }): Promise<void> {
  const ref = connectionRef("google-calendar");
  await db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    const connection = snap.value as unknown as ConnectionDoc | undefined;
    if (connection?.calendarProvisioning?.claimId !== claimId) throw new Error("calendar provisioning claim was lost");
    tx.put(ref, { calendarId: calendar.id, calendarTitle: calendar.summary, calendarProvisionedAt: new Date().toISOString(), calendarProvisioning: REMOVE_FIELD }, { merge: true });
  });
}

export async function markCalendarProvisioningUncertain(claimId: string): Promise<void> {
  const ref = connectionRef("google-calendar");
  await db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    const connection = snap.value as unknown as ConnectionDoc | undefined;
    if (connection?.calendarProvisioning?.claimId === claimId) {
      tx.put(ref, { calendarProvisioning: { status: "uncertain", claimId, at: new Date().toISOString() } }, { merge: true });
    }
  });
}

export function connectionRef(platform: string) {
  return recordKey(tenantCollection(CONNECTIONS).partition + "/" + platform);
}

export async function getConnection(platform: string): Promise<ConnectionDoc | null> {
  const snap = await awsRepository().read(connectionRef(platform));
  if (!snap.present) return null;
  return decodeConnection(snap.value as unknown as StoredConnectionDoc);
}

export async function saveConnection(conn: ConnectionDoc): Promise<void> {
  await awsRepository().put(connectionRef(conn.platform), encodeConnection(conn));
}

export type ConnectionRefreshClaim =
  | { outcome: "fresh"; connection: ConnectionDoc }
  | { outcome: "refresh"; claimId: string; connection: ConnectionDoc }
  | { outcome: "in_progress" }
  | { outcome: "uncertain" };

export async function claimConnectionTokenRefresh(platform: string): Promise<ConnectionRefreshClaim> {
  const ref = connectionRef(platform);
  return db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) throw new Error(`${platform} connection not found`);
    const stored = snap.value as unknown as StoredConnectionDoc;
    const connection = decodeConnection(stored);
    const claimId = newId();
    const decision = decideConnectionRefresh({
      expiresAt: connection.expiresAt,
      now: new Date().toISOString(),
      refreshSkewMs: 60_000,
      state: stored.tokenRefresh,
      claimId,
    });
    if (decision.outcome === "fresh") return { outcome: "fresh", connection };
    if (decision.outcome === "in_progress") return { outcome: "in_progress" };
    if (decision.outcome === "uncertain") {
      if (stored.tokenRefresh?.status === "claimed") tx.put(ref, { tokenRefresh: decision.state }, { merge: true });
      return { outcome: "uncertain" };
    }
    if (!connection.refreshToken) throw new Error(`${platform} authorization expired; reconnect it`);
    tx.put(ref, { tokenRefresh: decision.state }, { merge: true });
    return { outcome: "refresh", claimId, connection };
  });
}

export async function completeConnectionTokenRefresh(
  platform: string,
  claimId: string,
  connection: ConnectionDoc,
): Promise<void> {
  const ref = connectionRef(platform);
  await db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) throw new Error(`${platform} connection not found`);
    const stored = snap.value as unknown as StoredConnectionDoc;
    if (stored.tokenRefresh?.status !== "claimed" || stored.tokenRefresh.claimId !== claimId) {
      throw new Error("connection refresh claim was lost");
    }
    tx.put(ref, encodeConnection(connection));
  });
}

export async function markConnectionTokenRefreshUncertain(
  platform: string,
  claimId: string,
  reason: string,
): Promise<void> {
  const ref = connectionRef(platform);
  await db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) return;
    const stored = snap.value as unknown as StoredConnectionDoc;
    if (stored.tokenRefresh?.status !== "claimed" || stored.tokenRefresh.claimId !== claimId) return;
    tx.put(ref, {
      tokenRefresh: {
        ...stored.tokenRefresh,
        status: "uncertain",
        uncertainAt: new Date().toISOString(),
        reason,
      } satisfies ConnectionRefreshState,
    }, { merge: true });
  });
}

export async function deleteConnection(platform: string): Promise<void> {
  await awsRepository().remove(connectionRef(platform));
}

export async function listConnections(): Promise<ConnectionDoc[]> {
  const snaps = await awsRepository().query(tenantCollection(CONNECTIONS));
  return snaps.rows.map((doc) => {
    return decodeConnection(doc.value as unknown as StoredConnectionDoc);
  });
}

export async function listConnectionMetadata(): Promise<Array<Pick<ConnectionDoc, "platform" | "health" | "connectedAt">>> {
  const snaps = await awsRepository().query(tenantCollection(CONNECTIONS));
  return snaps.rows.map((doc) => {
    const stored = doc.value as unknown as StoredConnectionDoc;
    return { platform: stored.platform, health: stored.health, connectedAt: stored.connectedAt };
  });
}

// ---------- operator chat history ----------

const CHATS = "chat_messages";
const CHAT_SUMMARIES = "chat_summaries";
const CHAT_RETENTION_MAX = 300;

export interface ChatMessageDoc {
  userId: string;
  surface: ChatSurface;
  conversationId: string;
  scopeKey: string;
  role: "user" | "assistant";
  text: string;
  data?: Record<string, unknown>;
  at?: symbol | string;
}

export async function saveChatMessage(
  m: Omit<ChatMessageDoc, "at" | "userId" | "scopeKey"> & { at?: ChatMessageDoc["at"] },
  requestId?: string,
): Promise<void> {
  const tenant = currentTenant();
  const userId = tenantSubjectId(tenant);
  const scopeKey = chatScopeKey(userId, m.surface, m.conversationId, tenant.brandId);
  const document = { ...m, userId, scopeKey, at: new Date().toISOString() };
  if (document.data === undefined) delete document.data;
  const id = requestId ? createHash("sha256").update(JSON.stringify([scopeKey, requestId, m.role])).digest("hex") : newRecordId();
  const key = recordKey(tenantCollection(CHATS).partition + "/" + id);
  await awsRepository().atomic(async tx => {
    const prior = await tx.read(key);
    if (!prior.present) tx.insert(key, document);
  });
  const scoped = await awsRepository().query(where(tenantCollection(CHATS), "scopeKey", "==", scopeKey));
  const retained = scoped.rows.map((doc) => {
    const data = doc.value as unknown as ChatMessageDoc & { at?: string };
    return {
      id: doc.id,
      at: data.at ?? null,
      data: data.data,
    };
  });
  const plan = retentionPlan(retained, CHAT_RETENTION_MAX);
  if (!plan.summary) return;
  const batch = db().writeGroup();
  for (const id of plan.deleteIds) batch.remove(recordKey(tenantCollection(CHATS).partition + "/" + id));
  batch.insert(recordKey(tenantCollection(CHAT_SUMMARIES).partition + "/" + newId()), {
    userId,
    surface: m.surface,
    conversationId: m.conversationId,
    scopeKey,
    ...plan.summary,
    createdAt: new Date().toISOString(),
  });
  await batch.commit();
}

export async function listChatMessages(
  limit = 100,
  surface: ChatSurface = "dashboard",
  conversationId = "primary",
): Promise<Array<{ id: string; surface: string; role: string; text: string; data?: Record<string, unknown>; at: string | null }>> {
  const tenant = currentTenant();
  const scopeKey = chatScopeKey(tenantSubjectId(tenant), surface, conversationId, tenant.brandId);
  const snaps = await awsRepository().query(where(tenantCollection(CHATS), "scopeKey", "==", scopeKey));
  return snaps.rows
    .map((d) => {
      const data = d.value as unknown as { surface: string; role: string; text: string; data?: Record<string, unknown>; at?: string };
      return {
        id: d.id,
        surface: data.surface ?? "dashboard",
        role: data.role,
        text: data.text,
        data: data.data,
        at: data.at ?? null,
      };
    })
    .sort((a, b) => Date.parse(a.at ?? "0") - Date.parse(b.at ?? "0"))
    .slice(-Math.min(Math.max(limit, 1), CHAT_RETENTION_MAX));
}

/** All persisted messages for the current operator on one chat surface. */
export async function listAllChatMessages(
  limit = 100,
  surface: ChatSurface = "dashboard",
): Promise<Array<{ id: string; conversationId: string; surface: string; role: string; text: string; data?: Record<string, unknown>; at: string | null }>> {
  const tenant = currentTenant();
  const userId = tenantSubjectId(tenant);
  const snaps = await awsRepository().query(where(tenantCollection(CHATS), "userId", "==", userId));
  return snaps.rows
    .map((d) => {
      const data = d.value as unknown as { conversationId?: string; surface: string; role: string; text: string; data?: Record<string, unknown>; at?: string };
      return {
        id: d.id,
        conversationId: data.conversationId ?? "primary",
        surface: data.surface ?? "dashboard",
        role: data.role,
        text: data.text,
        data: data.data,
        at: data.at ?? null,
      };
    })
    .filter((message) => message.surface === surface)
    .sort((a, b) => Date.parse(a.at ?? "0") - Date.parse(b.at ?? "0"))
    .slice(-Math.min(Math.max(limit, 1), CHAT_RETENTION_MAX));
}

export interface OperatorGoals {
  weeklyPostTarget?: number;
  audience?: string;
  voice?: string;
  topics: string[];
  strategyContext?: import("./types").StrategyContext;
}

export async function getGoals(): Promise<OperatorGoals> {
  const snap = await awsRepository().read(recordKey(tenantCollection(CONFIG).partition + "/" + "operator"));
  const data = snap.value as unknown as { goals?: OperatorGoals } | undefined;
  return { topics: [], ...data?.goals };
}

export async function saveGoals(goals: OperatorGoals): Promise<void> {
  await awsRepository().put(recordKey(tenantCollection(CONFIG).partition + "/" + "operator"), { goals }, { merge: true });
}

export interface TelegramConnectionDoc {
  botToken: string;
  chatId: string;
  connectedAt: string;
  routeTokenDigest: string;
  webhookSecretDigest: string;
  chatIdDigest: string;
}

type StoredTelegramConnectionDoc = Omit<TelegramConnectionDoc, "botToken"> & { botTokenEnvelope: SecretEnvelope };

export interface TelegramDecisionNonceDoc {
  routeTokenDigest: string;
  workspaceId: string;
  brandId: string;
  jobId: string;
  actionId: string;
  target: "effect" | "strategy" | "strategy_feedback" | "production";
  payloadDigest: string;
  decision: "approved" | "rejected";
  feedback?: string;
  expiresAt: string;
  state: "pending" | "processing" | "consumed";
  claimedAt?: string;
  decisionId?: string;
}

const TELEGRAM_WEBHOOK_ROUTES = "telegram_webhook_routes";
const TELEGRAM_DECISION_NONCES = "telegram_decision_nonces";
const TELEGRAM_STRATEGY_PROMPTS = "telegram_strategy_prompts";

export async function createTelegramDecisionNonce(value: TelegramDecisionNonceDoc, nonce: string): Promise<void> {
  const nonceId = telegramDigest(`${value.routeTokenDigest}:${nonce}`);
  await awsRepository().insert(recordKey(partition(TELEGRAM_DECISION_NONCES).partition + "/" + nonceId), value);
}

export interface TelegramStrategyPromptDoc {
  routeTokenDigest: string; workspaceId: string; brandId: string; jobId: string;
  payloadDigest: string; actorSubjectId: string; expiresAt: string; state: "pending" | "processing" | "consumed";
  claimedAt?: string; decisionId?: string;
}

export async function saveTelegramStrategyPrompt(routeTokenDigest: string, messageId: number, value: TelegramStrategyPromptDoc): Promise<void> {
  await awsRepository().insert(recordKey(partition(TELEGRAM_STRATEGY_PROMPTS).partition + "/" + telegramDigest(`${routeTokenDigest}:${messageId}`)), value);
}

export async function claimTelegramStrategyPrompt(routeToken: string, messageId: number): Promise<{ duplicate: boolean; prompt: TelegramStrategyPromptDoc }> {
  const routeTokenDigest = telegramDigest(routeToken);
  const ref = recordKey(partition(TELEGRAM_STRATEGY_PROMPTS).partition + "/" + telegramDigest(`${routeTokenDigest}:${messageId}`));
  return db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) throw new Error("Telegram strategy feedback prompt not found");
    const value = snap.value as unknown as TelegramStrategyPromptDoc;
    if (value.routeTokenDigest !== routeTokenDigest) throw new Error("Telegram strategy prompt route mismatch");
    const decision = decideTelegramNonceClaim(value);
    if (decision.outcome === "duplicate") return { duplicate: true, prompt: value };
    const prompt = { ...value, state: "processing" as const, claimedAt: new Date().toISOString() };
    tx.patch(ref, prompt);
    return { duplicate: false, prompt };
  });
}

export async function finalizeTelegramStrategyPrompt(routeToken: string, messageId: number, decisionId: string): Promise<void> {
  const routeTokenDigest = telegramDigest(routeToken);
  await awsRepository().patch(recordKey(partition(TELEGRAM_STRATEGY_PROMPTS).partition + "/" + telegramDigest(`${routeTokenDigest}:${messageId}`)), { state: "consumed", decisionId });
}

export async function getTelegramWebhookRoute(routeToken: string): Promise<TelegramWebhookRoute | null> {
  const routeTokenDigest = telegramDigest(routeToken);
  const snap = await awsRepository().read(recordKey(partition(TELEGRAM_WEBHOOK_ROUTES).partition + "/" + routeTokenDigest));
  return snap.present ? (snap.value as unknown as TelegramWebhookRoute) : null;
}

export async function claimTelegramDecisionNonce(
  routeToken: string,
  nonce: string,
): Promise<{ duplicate: boolean; nonce: TelegramDecisionNonceDoc }> {
  const routeTokenDigest = telegramDigest(routeToken);
  const nonceId = telegramDigest(`${routeTokenDigest}:${nonce}`);
  const ref = recordKey(partition(TELEGRAM_DECISION_NONCES).partition + "/" + nonceId);
  return db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) throw new Error("Telegram decision nonce not found");
    const value = snap.value as unknown as TelegramDecisionNonceDoc;
    if (value.routeTokenDigest !== routeTokenDigest) throw new Error("Telegram decision nonce route mismatch");
    const decision = decideTelegramNonceClaim(value);
    if (decision.outcome === "duplicate") return { duplicate: true, nonce: value };
    const claimed = { ...value, state: "processing" as const, claimedAt: new Date().toISOString() };
    tx.patch(ref, claimed);
    return { duplicate: false, nonce: claimed };
  });
}

export async function finalizeTelegramDecisionNonce(
  routeToken: string,
  nonce: string,
  decisionId: string,
): Promise<void> {
  const routeTokenDigest = telegramDigest(routeToken);
  const nonceId = telegramDigest(`${routeTokenDigest}:${nonce}`);
  await awsRepository().patch(recordKey(partition(TELEGRAM_DECISION_NONCES).partition + "/" + nonceId), {
    state: "consumed",
    decisionId,
  });
}

export async function getTelegramConnection(): Promise<TelegramConnectionDoc | null> {
  const snap = await awsRepository().read(recordKey(tenantCollection(CONFIG).partition + "/" + "telegram"));
  if (!snap.present) return null;
  const stored = snap.value as unknown as StoredTelegramConnectionDoc;
  const { botTokenEnvelope, ...metadata } = stored;
  return {
    ...metadata,
    botToken: decryptSecret(
      botTokenEnvelope,
      connectionEnvelopeKey(),
      `${currentTenant().workspaceId}:telegram:bot`,
    ),
  };
}

export async function saveTelegramConnection(connection: TelegramConnectionDoc): Promise<void> {
  const tenant = currentTenant();
  const configRef = recordKey(tenantCollection(CONFIG).partition + "/" + "telegram");
  const routeRef = recordKey(partition(TELEGRAM_WEBHOOK_ROUTES).partition + "/" + connection.routeTokenDigest);
  const { botToken, ...metadata } = connection;
  const stored: StoredTelegramConnectionDoc = {
    ...metadata,
    botTokenEnvelope: encryptSecret(botToken, connectionEnvelopeKey(), `${tenant.workspaceId}:telegram:bot`),
  };
  await db().atomic(async (tx) => {
    const existing = await tx.read(configRef);
    const existingRoute = field(existing.value, "routeTokenDigest") as string | undefined;
    if (existingRoute && existingRoute !== connection.routeTokenDigest) {
      tx.remove(recordKey(partition(TELEGRAM_WEBHOOK_ROUTES).partition + "/" + existingRoute));
    }
    tx.put(configRef, stored);
    tx.put(routeRef, {
      routeTokenDigest: connection.routeTokenDigest,
      webhookSecretDigest: connection.webhookSecretDigest,
      chatIdDigest: connection.chatIdDigest,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
    } satisfies TelegramWebhookRoute);
  });
}

export async function deleteTelegramConnection(): Promise<void> {
  const configRef = recordKey(tenantCollection(CONFIG).partition + "/" + "telegram");
  await db().atomic(async (tx) => {
    const existing = await tx.read(configRef);
    const routeTokenDigest = field(existing.value, "routeTokenDigest") as string | undefined;
    if (routeTokenDigest) tx.remove(recordKey(partition(TELEGRAM_WEBHOOK_ROUTES).partition + "/" + routeTokenDigest));
    tx.remove(configRef);
  });
}

export interface AssetDoc {
  jobId: string;
  actionId: string;
  mime: string;
  digest: string;
  sizeBytes: number;
  storageUri: string;
  createdAt: string;
}

export function assetRef(jobId: string, actionId: string) {
  return recordKey(tenantCollection(ASSETS).partition + "/" + `${jobId}_${actionId}`);
}

export async function saveAsset(asset: AssetDoc): Promise<void> {
  await awsRepository().put(assetRef(asset.jobId, asset.actionId), asset);
}

export async function getAsset(jobId: string, actionId: string): Promise<AssetDoc | null> {
  const snap = await awsRepository().read(assetRef(jobId, actionId));
  if (!snap.present) return null;
  return snap.value as unknown as AssetDoc;
}

export async function listAssets(jobId: string): Promise<AssetDoc[]> {
  const snaps = await awsRepository().query(where(tenantCollection(ASSETS), "jobId", "==", jobId));
  return snaps.rows.map((d) => d.value as unknown as AssetDoc);
}

export async function listAllAssets(): Promise<AssetDoc[]> {
  const snaps = await awsRepository().query(limited(ordered(tenantCollection(ASSETS), "createdAt", "desc"), 100));
  return snaps.rows.map((d) => d.value as unknown as AssetDoc);
}

export interface ReceiptWithJob extends Receipt {
  jobTitle?: string;
}

export async function listRecentReceipts(limit = 200): Promise<ReceiptWithJob[]> {
  const snaps = await awsRepository().query(limited(ordered(tenantCollection(JOBS), "createdAt", "desc"), 50));
  const out: ReceiptWithJob[] = [];
  for (const doc of snaps.rows) {
    const data = doc.value as unknown as JobDoc;
    const rs = await awsRepository().query(partition(doc.key.path + "/" + RECEIPTS));
    for (const r of rs.rows) {
      const receipt = r.value as unknown as Receipt;
      out.push({
        ...receipt,
        jobTitle: data.sourceAnalysis?.summary ?? data.config.operatorBrief ?? `Source bundle ${data.config.sourceManifestId?.slice(0, 8) ?? ""}`,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt)).slice(0, limit);
}

function jobRef(jobId: string) {
  return recordKey(tenantCollection(JOBS).partition + "/" + jobId);
}

function requireJobDoc(snap: StoredRecord): Job & {
  actions: PlannedAction[];
  verifications: VerificationResult[];
  packet?: EvidencePacket;
} {
  if (!snap.present) throw new Error(`job not found: ${snap.id}`);
  const data = snap.value as unknown as JobDoc;
  assertResourceWorkspace(currentTenant(), data);
  return {
    id: snap.id,
    planRef: data.planRef,
    plannedItemRef: data.plannedItemRef,
    operatorPlanningContext: data.operatorPlanningContext,
    workspaceId: data.workspaceId,
    brandId: data.brandId,
    createdByUserId: data.createdByUserId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    status: data.status,
    terminalOutcome: data.terminalOutcome,
    retentionDeleteAfter: data.retentionDeleteAfter,
    retentionHold: data.retentionHold,
    stage: data.stage,
    config: data.config,
    controlEpoch: data.controlEpoch ?? 0,
    controlState: data.controlState ?? "running",
    campaignOutputPlan: data.campaignOutputPlan,
    contentArtifacts: data.contentArtifacts,
    artifactProductionResult: data.artifactProductionResult,
    artifactProductionDigest: data.artifactProductionDigest,
    artifactProductionCallbackDigest: data.artifactProductionCallbackDigest,
    artifactProductionCallbackClaimedAt: data.artifactProductionCallbackClaimedAt,
    artifactProductionCallbackCreatedAt: data.artifactProductionCallbackCreatedAt,
    artifactProductionCallbackTraceId: data.artifactProductionCallbackTraceId,
    failure: data.failure,
    strategyRef: data.strategyRef,
    strategyProposalId: data.strategyProposalId,
    strategyRevision: data.strategyRevision,
    strategyRevisionFeedback: data.strategyRevisionFeedback,
    strategyInvocationContext: data.strategyInvocationContext,
    editorialPlanRevision: data.editorialPlanRevision,
    activeProductionLineage: data.activeProductionLineage,
    editorialPlanningSnapshot: data.editorialPlanningSnapshot,
    editorialPlanningSnapshotDigest: data.editorialPlanningSnapshotDigest,
    editorialPlanningSnapshotHistory: data.editorialPlanningSnapshotHistory,
    sourceAnalysis: data.sourceAnalysis,
    analysisDigest: data.analysisDigest,
    analysisResearchRequest: data.analysisResearchRequest,
    analysisSearchEvidence: data.analysisSearchEvidence,
    analysisGroundingMetadata: data.analysisGroundingMetadata,
    analysisLearningEvidence: data.analysisLearningEvidence,
    actions: data.actions ?? [],
    verifications: data.verifications ?? [],
    packet: data.packet,
    budget: data.budget ?? initialJobBudget(),
  };
}

export async function eraseJobData(plan: DeletionPlan, actorSubjectId: string): Promise<void> {
  const tenant = currentTenant();
  if (plan.workspaceId !== tenant.workspaceId || plan.brandId !== tenant.brandId) {
    throw new Error("deletion plan is outside the current tenant scope");
  }
  const job = await getJob(plan.jobId);
  const contentItems = await awsRepository().query(where(tenantCollection(CONTENT_ITEMS), "jobId", "==", plan.jobId));
  const liveItem = contentItems.rows.find((doc) =>
    ["scheduled", "awaiting_final_review", "publishing"].includes(String(field(doc.value, "status"))),
  );
  if (liveItem) throw new Error("job has a content item with pending external work");

  const tombstoneRef = recordKey(tenantCollection(DELETION_TOMBSTONES).partition + "/" + plan.jobId);
  await awsRepository().put(tombstoneRef, {
    ...deletionTombstone(plan, actorSubjectId),
    state: "erasing",
  });
  const { revokeLearningObservations } = await import("./learning/repository");
  await revokeLearningObservations({ jobId: plan.jobId }, "Job evidence erased");

  const assets = await listAssets(plan.jobId);
  for (const asset of assets) await deleteArtifactUri(asset.storageUri);

  const manifestSnapshot = await awsRepository().read(recordKey(partition(jobRef(plan.jobId).path + "/" + "source_manifests").partition + "/" + job.config.sourceManifestId));
  const directSourceIds = (field(manifestSnapshot.value, "directSourceIds") as string[] | undefined) ?? [];
  const knowledgeErasureIds: string[] = [];
  for (const sourceId of directSourceIds) {
    const erasureId = await revokeSourceKnowledge(sourceId);
    if (erasureId) knowledgeErasureIds.push(erasureId);
    const payloadRef = recordKey(`workspaces/${job.workspaceId}/brands/${job.brandId}/source_payloads/${sourceId}`);
    const payload = await awsRepository().read(payloadRef);
    const attachmentId = field(payload.value, "input.attachmentId") as string | undefined;
    if (attachmentId) {
      const attachmentRef = recordKey(tenantCollection("chat_attachments").partition + "/" + attachmentId);
      const attachment = await awsRepository().read(attachmentRef);
      const uri = String(field(attachment.value, "storageUri") ?? "");
      if (uri) await deleteArtifactUri(uri);
      if (attachment.present) await awsRepository().remove(attachmentRef);
    }
    await awsRepository().remove(payloadRef);
  }

  const denormalized = await Promise.all([
    awsRepository().query(where(tenantCollection(ASSETS), "jobId", "==", plan.jobId)),
    awsRepository().query(where(tenantCollection(EVENT_LOG), "jobId", "==", plan.jobId)),
    awsRepository().query(where(tenantCollection(PROPOSALS), "jobId", "==", plan.jobId)),
    awsRepository().query(where(tenantCollection(NOTIFICATIONS), "refId", "==", plan.jobId)),
  ]);
  await Promise.all(denormalized.flatMap((snapshot) => snapshot.rows.map((doc) => awsRepository().remove(doc.key))));
  await Promise.all(contentItems.rows.map((doc) => awsRepository().remove(doc.key)));
  await db().removeTree(jobRef(plan.jobId));
  await awsRepository().put(tombstoneRef, { state: "erased", completedAt: new Date().toISOString(), knowledgeErasureIds, knowledgeErasureState: knowledgeErasureIds.length ? "pending" : "not_required" }, { merge: true });
}

export async function eraseDueJobs(now = new Date(), limit = 20): Promise<string[]> {
  const snapshots = await awsRepository().query(limited(where(tenantCollection(JOBS), "retentionDeleteAfter", "<=", now.toISOString()), Math.max(1, Math.min(limit, 100))));
  const erased: string[] = [];
  for (const snapshot of snapshots.rows) {
    const job = requireJobDoc(snapshot);
    if (job.retentionHold || !["complete", "failed"].includes(job.status)) continue;
    await eraseJobData({
      jobId: job.id,
      workspaceId: job.workspaceId,
      brandId: job.brandId,
      reason: "retention period elapsed",
      requestedAt: now.toISOString(),
    }, "retention-service");
    erased.push(job.id);
  }
  return erased;
}

export async function eraseWorkspaceData(
  plan: WorkspaceDeletionPlan,
  actorSubjectId: string,
): Promise<void> {
  const tenant = currentTenant();
  if (plan.workspaceId !== tenant.workspaceId) throw new Error("workspace deletion plan is out of scope");
  if (tenant.principal.workspaceRole !== "owner") throw new Error("workspace owner role required");

  const [jobs, contentItems, assets, attachments, telegram, connections, oauthStates, user] = await Promise.all([
    awsRepository().query(tenantCollection(JOBS)),
    awsRepository().query(tenantCollection(CONTENT_ITEMS)),
    awsRepository().query(tenantCollection(ASSETS)),
    awsRepository().query(tenantCollection("chat_attachments")),
    awsRepository().read(recordKey(tenantCollection(CONFIG).partition + "/" + "telegram")),
    awsRepository().query(tenantCollection(CONNECTIONS)),
    awsRepository().query(where(partition("oauth_states"), "workspaceId", "==", plan.workspaceId)),
    awsRepository().read(recordKey(partition("users").partition + "/" + actorSubjectId)),
  ]);
  if (jobs.rows.some((doc) => {
    const value = doc.value as unknown as JobDoc;
    return value.retentionHold || !["complete", "failed"].includes(value.status);
  })) {
    throw new Error("workspace contains active jobs or retention holds");
  }
  if (contentItems.rows.some((doc) =>
    ["scheduled", "awaiting_final_review", "publishing"].includes(String(field(doc.value, "status"))),
  )) {
    throw new Error("workspace contains pending external work");
  }
  if (!connections.empty) {
    throw new Error("disconnect external connections before workspace deletion");
  }

  const knowledgeErasureIds = await revokeWorkspaceKnowledge();
  const tombstoneRef = recordKey(partition("workspace_deletion_tombstones").partition + "/" + plan.workspaceId);
  await awsRepository().put(tombstoneRef, {
    workspaceId: plan.workspaceId,
    reason: plan.reason,
    requestedAt: plan.requestedAt,
    deletedBySubjectId: actorSubjectId,
    state: "erasing",
  });
  for (const doc of [...assets.rows, ...attachments.rows]) {
    const uri = String(field(doc.value, "storageUri") ?? "");
    if (uri) await deleteWorkspaceArtifactUri(uri, plan.workspaceId);
  }
  const routeTokenDigest = field(telegram.value, "routeTokenDigest") as string | undefined;
  if (routeTokenDigest) {
    await awsRepository().remove(recordKey(partition(TELEGRAM_WEBHOOK_ROUTES).partition + "/" + routeTokenDigest));
  }
  await Promise.all(oauthStates.rows.map((state) => awsRepository().remove(state.key)));
  await db().removeTree(recordKey(partition("workspaces").partition + "/" + plan.workspaceId));
  await db().eraseWorkspaceBlobs(plan.workspaceId);
  if (user.present && field(user.value, "defaultWorkspaceId") === plan.workspaceId) {
    await awsRepository().remove(user.key);
  }
  await awsRepository().put(tombstoneRef, {
    state: "erased",
    completedAt: new Date().toISOString(),
    contentErased: true,
    knowledgeErasureIds,
    knowledgeErasureState: knowledgeErasureIds.length ? "pending" : "not_required",
    oauthStatesErased: true,
    identityPointerErased: !user.present || field(user.value, "defaultWorkspaceId") === plan.workspaceId,
  }, { merge: true });
}

export async function insertExecutionJob(tx: DynamoTransaction, id: string, config: JobConfig, stage: Stage, context: Partial<Job> = {}) {
  const tenant = currentTenant(); const now = new Date().toISOString();
  const row = await tx.read(jobRef(id));
  if (row.present) throw new Error("planned execution already exists without item binding");
  const doc = { workspaceId: tenant.workspaceId, brandId: tenant.brandId, createdByUserId: tenantSubjectId(tenant), createdAt: now, updatedAt: now, status: "running", stage, config, controlEpoch: 0, controlState: "running", budget: initialJobBudget(), ...context };
  tx.insert(jobRef(id), doc);
  const outboxId = createStageOutboxInTransaction(tx, id, stage, 0);
  return { id, outboxId };
}

export async function createJob(
  config: JobConfig,
  initialStage: Stage,
  setup?: (transaction: DynamoTransaction, jobId: string, now: string) => void | Promise<void>,
  idempotentJobId?: string,
): Promise<Job> {
  const id = idempotentJobId ?? newId();
  const now = new Date().toISOString();
  const storedConfig: JobConfig = { ...config };
  if (storedConfig.strategyContext === undefined) delete storedConfig.strategyContext;
  if (storedConfig.analysisResearchRequest === undefined) delete storedConfig.analysisResearchRequest;
  if (!storedConfig.strategyContext) {
    const goals = await getGoals();
    if (goals.strategyContext) storedConfig.strategyContext = goals.strategyContext;
  }
  const tenant = currentTenant();
  const doc: JobDoc = {
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    createdByUserId: tenantSubjectId(tenant),
    createdAt: now,
    updatedAt: now,
    status: "running",
    stage: initialStage,
    config: storedConfig,
    controlEpoch: 0,
    controlState: "running",
    budget: initialJobBudget(),
  };
  const outboxId = stageOutboxId(id, initialStage, 0);
  return db().atomic(async (tx) => {
    if (idempotentJobId) {
      const existing = await tx.read(jobRef(id));
      if (existing.present) return requireJobDoc(existing);
    }
    const strategyRequest = config.intake && ["establish_strategy", "revise_strategy"].includes(config.intake.action);
    const active = initialStage === "strategize" || strategyRequest ? null : await readActiveStrategyRef(tx);
    if (active) doc.strategyRef = active;
    else delete doc.strategyRef;
    tx.insert(jobRef(id), doc);
    await setup?.(tx, id, now);
    tx.insert(stageOutboxRef(outboxId), {
      id: outboxId,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
      jobId: id,
      stage: initialStage,
      attempt: 0,
      ...stageOutboxDurability(outboxId, id, initialStage, 0),
      state: "pending",
      createdAt: now,
    } satisfies StageOutboxRecord);
    return { id, ...doc };
  });
}

function permanentRetryKey(jobId: string, id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid permanent retry authorization id");
  return recordKey(`${jobRef(jobId).path}/permanent_retry_authorizations/${id}`);
}
function permanentRetryResult(authorization: PermanentRetryAuthorization, replayed: boolean) {
  return { authorizationId: authorization.id, outboxId: authorization.outboxId ?? null, retryPending: authorization.state === "pending", state: authorization.state, replayed };
}

export async function authorizePermanentJobRetry(jobId: string, request: PermanentRetryRequest) {
  const tenant = currentTenant(); const actor = requireWorkspaceAdministrator(tenant);
  const input = permanentRetryRequestSchema.parse(request);
  const id = strategyDigest([tenant.workspaceId, tenant.brandId, actor.subjectId, input.requestId]);
  return db().atomic(async tx => {
    const job = requireJobDoc(await tx.read(jobRef(jobId)));
    const key = permanentRetryKey(jobId, id); const previous = await tx.read(key);
    if (previous.present) {
      const authorization = previous.value as unknown as PermanentRetryAuthorization;
      assertResourceWorkspace(tenant, authorization);
      if (authorization.requestDigest !== strategyDigest(input) || authorization.jobId !== jobId) throw new PermanentRetryConflict("permanent retry identity reused");
      return permanentRetryResult(authorization, true);
    }
    if (job.controlEpoch !== input.expectedGeneration || !job.failure || strategyDigest(job.failure) !== strategyDigest(input.expectedFailure)) throw new PermanentRetryConflict("retry failure or generation changed");
    if (job.failure.retryable) throw new PermanentRetryConflict("permanent failure required");
    try { authorizeJobRetry(job.failure, true, INTERNAL_CONTRACT_REVISION); }
    catch (error) { throw new PermanentRetryConflict(error instanceof Error ? error.message : String(error)); }
    const authorization: PermanentRetryAuthorization = { id, workspaceId: tenant.workspaceId, brandId: tenant.brandId, jobId, itemRef: job.plannedItemRef ?? null, actor, decision: "retry_after_fix", reason: input.reason, approvedAt: new Date().toISOString(), idempotencyKey: input.requestId, requestDigest: strategyDigest(input), expectedGeneration: job.controlEpoch, failureDigest: strategyDigest(job.failure), stage: job.failure.stage, state: "pending" };
    tx.insert(key, authorization);
    await retryJobInTransaction(tx, job, job.failure.stage, authorization);
    return permanentRetryResult(authorization, false);
  });
}

export async function retryFailedJobWithOutbox(
  jobId: string,
  stage: Stage | null,
  options: { permanentAuthorizationId?: string } = {},
): Promise<string | null> {
  const tenant = currentTenant();
  if (options.permanentAuthorizationId && tenant.principal.kind !== "service") requireWorkspaceAdministrator(tenant);
  return db().atomic(async (tx) => {
    const jobSnapshot = await tx.read(jobRef(jobId));
    const job = requireJobDoc(jobSnapshot);
    let authorization: PermanentRetryAuthorization | undefined;
    if (options.permanentAuthorizationId) {
      const row = await tx.read(permanentRetryKey(jobId, options.permanentAuthorizationId));
      if (!row.present) throw new Error("permanent retry authorization not found");
      authorization = row.value as unknown as PermanentRetryAuthorization;
      assertResourceWorkspace(tenant, authorization);
      if (authorization.jobId !== jobId || (stage !== null && authorization.state !== "pending" && authorization.stage !== stage)) throw new Error("permanent retry authorization binding mismatch");
      if (authorization.state !== "pending") return authorization.outboxId ?? null;
    }
    // Recovery resolves the stage from the authorization even if failure authority disappeared.
    const retryStage = stage ?? authorization?.stage;
    if (!retryStage) throw new Error("retry stage authority required");
    return retryJobInTransaction(tx, job, retryStage, authorization);
  });
}

async function retryJobInTransaction(tx: DynamoTransaction, job: Job, stage: Stage, authorization?: PermanentRetryAuthorization): Promise<string | null> {
    const tenant = currentTenant(); const jobId = job.id;
    if (authorization && (job.controlEpoch !== authorization.expectedGeneration || strategyDigest(job.plannedItemRef ?? null) !== strategyDigest(authorization.itemRef) || !job.failure || job.failure.stage !== authorization.stage || strategyDigest(job.failure) !== authorization.failureDigest)) {
      authorization.state = "stale"; authorization.staleAt = new Date().toISOString();
      tx.patch(permanentRetryKey(jobId, authorization.id), authorization);
      if (authorization.itemRef) {
        const state = await readItemState(authorization.itemRef, tx);
        const { permanentRetryAuthorizationId: _authorizationId, ...next } = state; void _authorizationId;
        if (state.jobId === jobId && state.permanentRetryAuthorizationId === authorization.id) tx.put(authorityKey("planned_item_states", authorization.itemRef), { ...next, retryPending: false, reason: "Permanent retry authorization is stale; a new administrator decision is required", updatedAt: authorization.staleAt });
      }
      return null;
    }
    if (!job.failure && job.plannedItemRef && job.stage === stage) {
      const state = await readItemState(job.plannedItemRef, tx);
      if (state.status === "running" && state.jobId === jobId && state.outboxId) {
        const delivery = await tx.read(stageOutboxRef(state.outboxId));
        if (delivery.value?.jobId === jobId && delivery.value?.stage === stage && delivery.value?.operationId === operationIdForStageGeneration(jobId, stage, job.controlEpoch)) return state.outboxId;
      }
    }
    if (!job.failure || job.failure.stage !== stage || (job.status !== "failed" && !job.failure.retryable)) throw new Error("job is not retryable from this stage");
    if (!job.failure.retryable && !authorization) throw new Error("permanent failure requires a durable deployed-fix authorization");
    if (!isKnownStage(stage) || ["complete", "failed"].includes(stage)) throw new PermanentRetryConflict("stage is not retryable");
    const generation = job.controlEpoch + 1;
    const id = stageOutboxId(jobId, stage, generation);
    const ref = stageOutboxRef(id);
    const existing = await tx.read(ref);
    if (job.plannedItemRef) {
      const state = await readItemState(job.plannedItemRef, tx);
      if (state.jobId !== jobId) throw new Error("planned execution binding mismatch");
      const { permanentRetryAuthorizationId: priorAuthorizationId, ...unboundState } = state;
      if (!authorization && priorAuthorizationId) {
        const priorKey = permanentRetryKey(jobId, priorAuthorizationId); const prior = await tx.read(priorKey);
        if (prior.present) {
          assertResourceWorkspace(tenant, prior.value as { workspaceId: string; brandId: string });
          if (prior.value?.state === "pending") tx.patch(priorKey, { state: "stale", staleAt: new Date().toISOString() });
        }
      }
      const item = await readPlannedItem(job.plannedItemRef, tx);
      const reasons = await plannedItemAdmission(tx, item, new Date().toISOString());
      if (job.controlState !== "running") reasons.push(`execution is ${job.controlState}`);
      if (reasons.length) {
        const next = { ...unboundState, status: "failed", retryPending: true, ...(authorization ? { permanentRetryAuthorizationId: authorization.id } : {}), reason: reasons.join("; "), updatedAt: new Date().toISOString() };
        // Repeated pending admission checks have no write or audit side effects.
        if (state.retryPending && state.reason === next.reason && state.permanentRetryAuthorizationId === next.permanentRetryAuthorizationId) return null;
        tx.put(authorityKey("planned_item_states", job.plannedItemRef), next);
        return null;
      }
      tx.put(authorityKey("planned_item_states", job.plannedItemRef), { ...unboundState, status: "running", retryPending: false, outboxId: id, reason: "", updatedAt: new Date().toISOString() });
    }
    tx.patch(jobRef(jobId), {
      stage,
      status: "running",
      controlEpoch: generation,
      failure: REMOVE_FIELD,
      updatedAt: new Date().toISOString(),
    });
    if (!existing.present) tx.insert(ref, {
      id, workspaceId: tenant.workspaceId, brandId: tenant.brandId, jobId, stage, attempt: 0,
      ...stageOutboxDurability(id, jobId, stage, generation),
      state: "pending", createdAt: new Date().toISOString(),
    } satisfies StageOutboxRecord);
    if (authorization) {
      Object.assign(authorization, { state: "consumed", outboxId: id, admittedGeneration: generation, consumedAt: new Date().toISOString() });
      tx.patch(permanentRetryKey(jobId, authorization.id), authorization);
    }
    return id;
}

export async function getJob(jobId: string) {
  const snap = await awsRepository().read(jobRef(jobId));
  return resolveJobStrategy(requireJobDoc(snap));
}

export async function listJobs(limit = 25): Promise<Job[]> {
  const snaps = await awsRepository().query(limited(ordered(where(tenantCollection(JOBS), "brandId", "==", currentTenant().brandId), "createdAt", "desc"), limit));
  return Promise.all(snaps.rows.map((d) => resolveJobStrategy(requireJobDoc(d))));
}

export async function setStage(
  jobId: string,
  stage: Stage,
  status: Job["status"] = "running",
): Promise<void> {
  await awsRepository().patch(jobRef(jobId), {
    stage,
    status,
    updatedAt: new Date().toISOString(),
  });
}

function stageClaimDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function assertStageOperationId(jobId: string, stage: string, operationId: string): void {
  const prefix = `${operationIdForStage(jobId, stage)}:generation:`;
  const rawGeneration = operationId.startsWith(prefix) ? operationId.slice(prefix.length) : "";
  if (!/^(0|[1-9]\d*)$/.test(rawGeneration)) throw new Error("stage execution operation mismatch");
  const generation = Number(rawGeneration);
  if (!Number.isSafeInteger(generation) || operationId !== operationIdForStageGeneration(jobId, stage, generation)) throw new Error("stage execution operation mismatch");
}

export async function claimJobStageExecution(input: {
  jobId: string;
  stage: string;
  ownerId: string;
  claimToken: string;
  operationId: string;
}): Promise<StageClaimResult> {
  assertStageOperationId(input.jobId, input.stage, input.operationId);
  const ref = jobRef(input.jobId);
  const executionRef = recordKey(partition(ref.path + "/" + STAGE_EXECUTIONS).partition + "/" + createHash("sha256").update(input.operationId).digest("hex"));
  return db().atomic(async (tx) => {
    const [jobSnap, executionSnap] = await Promise.all([tx.read(ref), tx.read(executionRef)]);
    const job = requireJobDoc(jobSnap);
    const existing = executionSnap.present ? executionSnap.value as unknown as StageExecution : null;
    if (!existing && job.stage !== input.stage) throw new Error(`job stage is '${job.stage}', not '${input.stage}'`);
    if (!existing) {
      const admission = decideWorkAdmission(job.controlState);
      if (admission.outcome !== "execute") return admission;
    }
    const now = new Date();
    const result = decideStageClaim(existing, {
      jobId: input.jobId,
      stage: input.stage,
      operationId: input.operationId,
      ownerId: input.ownerId,
      claimTokenDigest: stageClaimDigest(input.claimToken),
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    });
    if (!existing) tx.insert(executionRef, result.execution);
    else if (result.execution !== existing) tx.put(executionRef, result.execution);
    return result;
  });
}

export async function finalizeJobStageExecution(input: {
  jobId: string;
  stage: string;
  operationId: string;
  claimToken: string;
  outcome: "applied" | "failed" | "uncertain";
  failureReason?: string;
}): Promise<StageExecution> {
  assertStageOperationId(input.jobId, input.stage, input.operationId);
  const ref = recordKey(partition(jobRef(input.jobId).path + "/" + STAGE_EXECUTIONS).partition + "/" + createHash("sha256").update(input.operationId).digest("hex"));
  return db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    if (!snap.present) throw new Error("stage execution claim not found");
    const current = snap.value as unknown as StageExecution;
    const finalized = finalizeStageExecution(
      current,
      stageClaimDigest(input.claimToken),
      input.outcome,
      new Date().toISOString(),
      input.failureReason,
    );
    tx.put(ref, finalized);
    return finalized;
  });
}

export interface BudgetReservation extends CostReservationState {
  jobId: string;
  operationId: string;
  stage: string;
  role: string;
  model: string;
  estimatedCostUsd: string;
  pricingVersion: string;
  modelPolicy?: import("./types").ModelPolicySnapshot;
  accepted: boolean;
  createdAt: string;
}

export async function reserveJobBudget(
  input: Omit<BudgetReservation, "accepted" | "createdAt" | keyof CostReservationState>,
  options: { approvalAuthorized?: boolean } = {},
): Promise<{ reserved: boolean; duplicate: boolean; budget: JobBudget }> {
  const ref = jobRef(input.jobId);
  const reservationRef = recordKey(partition(ref.path + "/" + COST_RESERVATIONS).partition + "/" + input.operationId);
  const workspaceRef = recordKey(partition("workspaces").partition + "/" + currentTenant().workspaceId);
  return db().atomic(async (tx) => {
    const [jobSnap, reservationSnap, workspaceSnap] = await Promise.all([
      tx.read(ref), tx.read(reservationRef), tx.read(workspaceRef),
    ]);
    const job = requireJobDoc(jobSnap);
    const budget = job.budget ?? initialJobBudget();
    if (reservationSnap.present) {
      const existing = reservationSnap.value as unknown as BudgetReservation;
      return { reserved: existing.accepted, duplicate: true, budget };
    }

    if (!workspaceSnap.present) throw new Error("workspace not found");
    const workspaceBudget = (field(workspaceSnap.value, "budget") as JobBudget | undefined) ?? {
      estimatedUsd: "0.00",
      observedUsd: "0.00",
      reservedUsd: "0.00",
      limitUsd: parseBudgetConfig(process.env).DEFAULT_WORKSPACE_BUDGET_USD,
      approvalThresholdUsd: budget.approvalThresholdUsd,
    };
    const accepted = (options.approvalAuthorized || !exceedsApprovalThreshold(budget, input.estimatedCostUsd))
      && canReserve(budget, input.estimatedCostUsd)
      && canReserve(workspaceBudget, input.estimatedCostUsd);
    const now = new Date();
    const reservation: BudgetReservation = {
      ...input,
      accepted,
      state: "reserved",
      reservedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      createdAt: now.toISOString(),
    };
    tx.put(reservationRef, reservation);
    if (!accepted) return { reserved: false, duplicate: false, budget };

    const updated = applyReservation(budget, input.estimatedCostUsd);
    tx.patch(ref, { budget: updated, updatedAt: new Date().toISOString() });
    tx.patch(workspaceRef, {
      budget: applyReservation(workspaceBudget, input.estimatedCostUsd),
      updatedAt: new Date().toISOString(),
    });
    return { reserved: true, duplicate: false, budget: updated };
  });
}

export async function finalizeUsageRecord(record: UsageRecord): Promise<{ duplicate: boolean }> {
  return db().atomic(tx => finalizeUsageRecordInTransaction(tx,record));
}

export async function finalizeUsageRecordInTransaction(tx: import("./dynamo").DynamoTransaction,record: UsageRecord): Promise<{ duplicate: boolean }> {
  const ref = jobRef(record.jobId);
  const reservationRef = recordKey(partition(ref.path + "/" + COST_RESERVATIONS).partition + "/" + record.operationId);
  const usageRef = recordKey(partition(ref.path + "/" + USAGE_RECORDS).partition + "/" + record.id);
  const workspaceRef = recordKey(partition("workspaces").partition + "/" + currentTenant().workspaceId);
    const [jobSnap, reservationSnap, usageSnap, workspaceSnap] = await Promise.all([
      tx.read(ref),
      tx.read(reservationRef),
      tx.read(usageRef),
      tx.read(workspaceRef),
    ]);
    if (usageSnap.present) return { duplicate: true };
    const job = requireJobDoc(jobSnap);
    if (!reservationSnap.present) throw new Error(`missing cost reservation: ${record.operationId}`);
    const reservation = reservationSnap.value as unknown as BudgetReservation;
    if (!reservation.accepted) throw new Error(`cost reservation was rejected: ${record.operationId}`);
    if (reservation.state !== "reserved") throw new Error(`cost reservation is ${reservation.state}: ${record.operationId}`);

    const budget = applyFinalizedUsage(
      job.budget ?? initialJobBudget(),
      reservation.estimatedCostUsd,
      record.observedCostUsd ?? record.estimatedCostUsd,
    );
    if (!workspaceSnap.present) throw new Error("workspace not found");
    const workspaceBudget = field(workspaceSnap.value, "budget") as JobBudget;
    const finalizedWorkspaceBudget = applyFinalizedUsage(
      workspaceBudget,
      reservation.estimatedCostUsd,
      record.observedCostUsd ?? record.estimatedCostUsd,
    );
    tx.put(usageRef, record);
    tx.patch(reservationRef, markReservationFinalized(reservation, new Date().toISOString()));
    tx.patch(ref, { budget, updatedAt: new Date().toISOString() });
    tx.patch(workspaceRef, {
      budget: finalizedWorkspaceBudget,
      updatedAt: new Date().toISOString(),
    });
    return { duplicate: false };
}

export async function resolveJobBudgetReservation(input: {
  jobId: string;
  operationId: string;
  outcome: "not_invoked" | "uncertain";
  reason: string;
}): Promise<{ duplicate: boolean; state: CostReservationState["state"] }> {
  return db().atomic(tx => resolveJobBudgetReservationInTransaction(tx,input));
}

export async function resolveJobBudgetReservationInTransaction(tx: import("./dynamo").DynamoTransaction, input: {
  jobId: string;
  operationId: string;
  outcome: "not_invoked" | "uncertain";
  reason: string;
}): Promise<{ duplicate: boolean; state: CostReservationState["state"] }> {
  const ref = jobRef(input.jobId);
  const reservationRef = recordKey(partition(ref.path + "/" + COST_RESERVATIONS).partition + "/" + input.operationId);
  const workspaceRef = recordKey(partition("workspaces").partition + "/" + currentTenant().workspaceId);
    const [jobSnap, reservationSnap, workspaceSnap] = await Promise.all([
      tx.read(ref), tx.read(reservationRef), tx.read(workspaceRef),
    ]);
    const job = requireJobDoc(jobSnap);
    if (!reservationSnap.present) throw new Error(`missing cost reservation: ${input.operationId}`);
    const reservation = reservationSnap.value as unknown as BudgetReservation;
    if (!reservation.accepted) throw new Error(`cost reservation was rejected: ${input.operationId}`);
    if (reservation.state !== "reserved") return { duplicate: true, state: reservation.state };

    const now = new Date().toISOString();
    if (input.outcome === "uncertain") {
      const uncertain = markReservationUncertain(reservation, input.reason, now);
      tx.patch(reservationRef, uncertain);
      return { duplicate: false, state: "uncertain" };
    }

    if (!workspaceSnap.present) throw new Error("workspace not found");
    const workspaceBudget = field(workspaceSnap.value, "budget") as JobBudget;
    const budget = applyReleasedReservation(job.budget ?? initialJobBudget(), reservation.estimatedCostUsd);
    const releasedWorkspaceBudget = applyReleasedReservation(workspaceBudget, reservation.estimatedCostUsd);
    tx.patch(reservationRef, { ...markReservationReleased(reservation, now), releaseReason: input.reason });
    tx.patch(ref, { budget, updatedAt: now });
    tx.patch(workspaceRef, { budget: releasedWorkspaceBudget, updatedAt: now });
    return { duplicate: false, state: "released" };
}

export async function listUsageRecords(jobId: string): Promise<UsageRecord[]> {
  const snaps = await awsRepository().query(ordered(partition(jobRef(jobId).path + "/" + USAGE_RECORDS), "createdAt", "asc"));
  return snaps.rows.map((doc) => doc.value as unknown as UsageRecord);
}

export interface MediaOperationRecord {
  jobId: string;
  actionId: string;
  provider: "nova_reel" | "elevenlabs";
  operationName: string;
  createdAt: string;
}

export async function saveMediaOperation(
  jobId: string,
  actionId: string,
  provider: "nova_reel" | "elevenlabs",
  operationName: string,
): Promise<MediaOperationRecord> {
  const ref = recordKey(partition(jobRef(jobId).path + "/" + MEDIA_OPERATIONS).partition + "/" + actionId);
  return db().atomic(async (tx) => {
    const existing = await tx.read(ref);
    if (existing.present) {
      const record = existing.value as unknown as MediaOperationRecord;
      if (record.provider !== provider || record.operationName !== operationName) {
        throw new Error(`media operation already recorded for action ${actionId}`);
      }
      return record;
    }
    const job = requireJobDoc(await tx.read(jobRef(jobId)));
    const action = (job.actions ?? []).find((item) => item.id === actionId);
    if (!action) throw new Error(`action ${actionId} not found on job ${jobId}`);
    const record: MediaOperationRecord = {
      jobId, actionId, provider, operationName, createdAt: new Date().toISOString(),
    };
    tx.put(ref, record);
    return record;
  });
}

export async function getMediaOperation(
  jobId: string,
  actionId: string,
): Promise<MediaOperationRecord | null> {
  const snap = await awsRepository().read(recordKey(partition(jobRef(jobId).path + "/" + MEDIA_OPERATIONS).partition + "/" + actionId));
  return snap.present ? (snap.value as unknown as MediaOperationRecord) : null;
}

export async function saveAnalysis(
  jobId: string,
  sourceAnalysis: import("./types").SourceAnalysis,
  analysisDigest: string,
  analysisResearchRequest: import("./types").AnalysisResearchRequest | null,
  analysisSearchEvidence: import("./types").AnalysisSearchEvidence[],
  analysisGroundingMetadata: Record<string, unknown> | null,
  learningEvidence: Array<{ id: string; digest: string }> = [],
) {
  await awsRepository().atomic(async tx => {
    const { validateLearningReference } = await import("./learning/proposals");
    const resolved = await Promise.all(learningEvidence.map(ref => validateLearningReference(ref.id, ref.digest, tx)));
    const allowed = new Set(resolved.filter(ref => ref.capability === "performance").map(ref => ref.id));
    for (const angle of sourceAnalysis.angles) if (angle.evidenceKind === "performance" && angle.evidenceRefs.some(id => !allowed.has(id))) throw new Error("unknown authoritative learning evidence in analysis");
    tx.patch(jobRef(jobId), {
    sourceAnalysis,
    analysisDigest,
    analysisResearchRequest,
    analysisSearchEvidence,
    analysisGroundingMetadata,
    analysisLearningEvidence: learningEvidence,
    updatedAt: new Date().toISOString(),
    });
  });
}

export async function saveCampaignOutputPlan(jobId: string, campaignOutputPlan: import("./types").CampaignOutputPlan): Promise<void> { await awsRepository().patch(jobRef(jobId), { campaignOutputPlan, updatedAt: new Date().toISOString() }); }

export async function acceptStrategyProposal(
  jobId: string, strategy: import("./types").ContentStrategy, digest: string, revision: number,
  searchEvidence: import("./types").StrategySearchEvidence[], groundingMetadata: Record<string, unknown> | null,
) {
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.read(ref);
    const job = requireJobDoc(snap);
    assertStrategyProposalRevision(job.stage, job.strategyRevision, revision, strategy.version);
    if (job.strategyRef) throw new Error("production job already pins an approved strategy");
    const invocationContext = {
      ...job.strategyInvocationContext,
      searchEvidence,
      groundingMetadata,
    } as import("./types").StrategyInvocationContext;
    validateStrategySearchGrounding(invocationContext.researchRequest, searchEvidence, groundingMetadata);
    validatePersistedStrategy({ ...job, strategyInvocationContext: invocationContext }, strategy);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const evidenceLineage = [...new Set([
      ...strategy.objectives.flatMap((item) => item.evidenceRefs),
      ...strategy.audiencePriorities.flatMap((item) => item.evidenceRefs),
      ...strategy.pillars.flatMap((item) => item.evidenceRefs),
      ...strategy.campaignThemes.flatMap((item) => item.evidenceRefs),
      ...strategy.channelRoles.flatMap((item) => item.evidenceRefs),
      ...strategy.kpis.flatMap((item) => item.evidenceRefs),
      ...strategy.briefs.flatMap((item) => item.evidenceRefs),
      ...strategy.assumptions.flatMap((item) => item.evidenceRefs),
    ])].sort();
    const proposal = await insertStrategyProposal(tx, { jobId, attempt: revision, strategy, digest, evidenceLineage, invocationContext, proposedAt: new Date().toISOString(), expiresAt }, job.config.intake?.strategyBaseRef);
    tx.patch(ref, {
      strategyProposalId: proposal.id, strategyRevision: revision,
      stage: "awaiting_strategy_approval", status: "waiting_for_approval", updatedAt: new Date().toISOString(),
    });
    return { digest, expiresAt, evidenceLineage };
  });
}

export async function saveStrategyInvocationContext(jobId: string, context: import("./types").StrategyInvocationContext) {
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.read(ref);
    const job = requireJobDoc(snap);
    assertStrategyProposalRevision(job.stage, job.strategyRevision, context.revision, context.revision);
    const configured = job.config.strategyContext;
    if (!configured) throw new Error("typed strategy context required");
    if (JSON.stringify([...context.operatorContextIds].sort()) !== JSON.stringify(["context:campaign", "context:company"])) throw new Error("strategy operator context IDs mismatch");
    const textOnly = job.config.intake && !job.config.sourceManifestId && Boolean(job.config.operatorBrief);
    if ((!job.sourceAnalysis || !job.analysisDigest) && !textOnly) throw new Error("persisted source analysis required");
    const sourceIds = job.sourceAnalysis ? strategySourceEvidenceIds(job.sourceAnalysis) : [];
    if (JSON.stringify([...context.sourceIds].sort()) !== JSON.stringify(sourceIds)) throw new Error("strategy source context mismatch");
    if (JSON.stringify([...context.audienceIds].sort()) !== JSON.stringify(configured.audiences.map((item) => item.id).sort())) throw new Error("strategy audience context mismatch");
    if (JSON.stringify([...context.requestedChannels].sort()) !== JSON.stringify([...configured.requestedChannels].sort())) throw new Error("strategy requested channels mismatch");
    if (JSON.stringify([...context.supportedChannels].sort()) !== JSON.stringify([...configured.supportedChannels].sort())) throw new Error("strategy supported channels mismatch");
    if (context.horizonWeeks !== (configured.horizonWeeks ?? 4)) throw new Error("strategy horizon mismatch");
    if (JSON.stringify(context.researchRequest) !== JSON.stringify(configured.researchRequest ?? null)) throw new Error("strategy research request mismatch");
    if (context.searchEvidence.length) throw new Error("strategy search evidence cannot exist before Ryan runs");
    const { validateLearningReference } = await import("./learning/proposals");
    for (const evidence of context.learningEvidence ?? []) await validateLearningReference(evidence.id, evidence.digest, tx);
    for (const performance of context.performance) if (!(context.learningEvidence ?? []).some(ref => ref.id === performance.id && performance.durableEvidenceRef === ref.id)) throw new Error("performance context must pin exact observation evidence");
    for (const evidence of job.analysisLearningEvidence ?? []) {
      await validateLearningReference(evidence.id, evidence.digest, tx);
      if (!(context.learningEvidence ?? []).some(ref => ref.id === evidence.id && ref.digest === evidence.digest)) throw new Error("strategy must retain exact analysis learning lineage");
    }
    tx.patch(ref, { strategyInvocationContext: context, updatedAt: new Date().toISOString() });
  });
}

export async function acceptEditorialPlan(
  jobId: string,
  plan: import("./types").EditorialPlan,
  revision: number,
) {
  const accepted = await db().atomic(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.read(ref);
    const job = await resolveJobStrategy(requireJobDoc(snap), tx);
    const digest = editorialPlanDigest(plan);
    const evidenceLineage = editorialPlanEvidenceLineage(plan);
    if (job.planRef) {
      const prior = await readPlan(job.planRef, tx);
      if (revision !== prior.ref.revision || prior.acceptedEditorialDigest !== digest) throw new Error("editorial plan already accepted; use an audited planning revision command");
      return { digest, evidenceLineage, selectedNextItemId: plan.selectedNextItemId, planRef: prior.ref };
    }
    assertEditorialPlanSubmission(job, plan, revision);
    const acceptedAt = new Date().toISOString();
    const authority = await persistEditorialPlan(tx, job, plan);
    tx.patch(ref, {
      planRef: authority.ref, stage: "complete", status: "complete", terminalOutcome: "succeeded", updatedAt: acceptedAt,
      editorialPlanningSnapshot: REMOVE_FIELD, editorialPlanningSnapshotDigest: REMOVE_FIELD, editorialPlanningSnapshotHistory: REMOVE_FIELD,
    });
    return { digest, evidenceLineage, selectedNextItemId: plan.selectedNextItemId, planRef: authority.ref };
  });
  const claim = await claimNextPlannedItem(accepted.planRef.id);
  return { ...accepted, executionJobId: claim?.jobId, outboxId: claim?.outboxId };
}

export async function claimSelectedEditorialItem(
  jobId: string,
  authority: { editorialPlanId: string; editorialPlanDigest: string; editorialItemId: string; briefId: string },
) {
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.read(ref);
    const job = await resolveJobStrategy(requireJobDoc(snap), tx);
    if (!job.plannedItemRef || !job.planRef) throw new Error("durable planned item authority required for production");
    if (isMatchingActiveProduction(job, authority)) {
      return { outcome: "execute" as const, resumed: true, ...authority };
    }
    assertSelectedProductionAuthority(job, authority, "selected");
    const updatedAt = new Date().toISOString();
    tx.patch(ref, {
      activeProductionLineage: authority,
      updatedAt,
    });
    return { outcome: "execute" as const, ...authority };
  });
}

export async function finalizeArtifactProduction(
  jobId: string,
  lineage: { editorialPlanId: string; editorialPlanDigest: string; editorialItemId: string; briefId: string },
  productionResult: import("./contentArtifacts/submission").ArtifactProductionResult,
  artifacts: import("./contentArtifacts/contracts").ContentArtifact[],
  actions: PlannedAction[],
  needsApproval: boolean,
) {
  const traceDigest = createHash("sha256").update(canonicalJson(productionResult), "utf8").digest("hex");
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId); const snap = await tx.read(ref); const job = await resolveJobStrategy(requireJobDoc(snap), tx);
    if (!job.plannedItemRef || !job.planRef) throw new Error("durable planned item authority required for production");
    if (job.artifactProductionResult && job.artifactProductionDigest === traceDigest) return { outcome: "already_applied" as const };
    if (job.artifactProductionCallbackDigest !== traceDigest) throw new Error("artifact production callback is not durably claimed");
    assertSelectedProductionAuthority(job, lineage, "drafting");
    const active = job.activeProductionLineage;
    if (!active || active.editorialPlanId !== lineage.editorialPlanId || active.editorialPlanDigest !== lineage.editorialPlanDigest || active.editorialItemId !== lineage.editorialItemId || active.briefId !== lineage.briefId) throw new Error("production lineage mismatch");
    const linkedActions = actions.map((action) => ({ ...action, ...lineage })); const updatedAt = new Date().toISOString();
    tx.patch(ref, { artifactProductionResult: productionResult, contentArtifacts: artifacts, artifactProductionDigest: traceDigest, artifactProductionCallbackDigest: REMOVE_FIELD, artifactProductionCallbackClaimedAt: REMOVE_FIELD, artifactProductionCallbackCreatedAt: REMOVE_FIELD, artifactProductionCallbackTraceId: REMOVE_FIELD, actions: linkedActions, ...(needsApproval ? { stage: "awaiting_approval", status: "waiting_for_approval" } : {}), updatedAt });
    const itemState = await readItemState(job.plannedItemRef, tx);
    tx.put(authorityKey("planned_item_states", job.plannedItemRef), { ...itemState, status: needsApproval ? "awaiting_approval" : "running", updatedAt });
    for (const artifact of artifacts) {
      const revisionRef = recordKey(partition(recordKey(partition(ref.path + "/" + "content_artifacts").partition + "/" + artifact.id).path + "/" + "revisions").partition + "/" + String(artifact.revision));
      tx.insert(revisionRef, artifact);
      tx.put(recordKey(partition(ref.path + "/" + "content_artifacts").partition + "/" + artifact.id), { id: artifact.id, currentRevision: artifact.revision, contentDigest: artifact.contentDigest, outputType: artifact.outputType, title: artifact.title, updatedAt });
    }
    return { outcome: "execute" as const, artifacts, actions: linkedActions };
  });
}

/** Reserve one durable callback before it can mutate a production-plan revision. */
export async function claimArtifactProductionCallback(jobId: string, productionResult: import("./contentArtifacts/submission").ArtifactProductionResult, identity?: { createdAt: string; traceId: string }) {
  const traceDigest = createHash("sha256").update(canonicalJson(productionResult), "utf8").digest("hex");
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId); const snap = await tx.read(ref); const job = await resolveJobStrategy(requireJobDoc(snap), tx);
    if (job.artifactProductionResult && job.artifactProductionDigest === traceDigest) return { outcome: "already_applied" as const, traceDigest, createdAt: job.artifactProductionCallbackCreatedAt, traceId: job.artifactProductionCallbackTraceId };
    if (job.artifactProductionCallbackDigest && job.artifactProductionCallbackDigest !== traceDigest) throw new Error("another artifact production callback is active");
    const now = new Date();
    const claimedAt = job.artifactProductionCallbackClaimedAt ? Date.parse(job.artifactProductionCallbackClaimedAt) : Number.NaN;
    if (job.artifactProductionCallbackDigest === traceDigest && Number.isFinite(claimedAt) && now.getTime() - claimedAt < 5 * 60 * 1000) {
      return { outcome: "in_progress" as const, traceDigest, createdAt: job.artifactProductionCallbackCreatedAt!, traceId: job.artifactProductionCallbackTraceId! };
    }
    const createdAt = job.artifactProductionCallbackCreatedAt ?? identity?.createdAt ?? now.toISOString();
    const traceId = job.artifactProductionCallbackTraceId ?? identity?.traceId ?? "0".repeat(32);
    tx.patch(ref, { artifactProductionCallbackDigest: traceDigest, artifactProductionCallbackClaimedAt: now.toISOString(), artifactProductionCallbackCreatedAt: createdAt, artifactProductionCallbackTraceId: traceId, updatedAt: now.toISOString() });
    return { outcome: "execute" as const, traceDigest, createdAt, traceId };
  });
}

export async function decideStrategy(jobId: string, input: StrategyDecisionInput) {
  const tenant = currentTenant();
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.read(ref);
    const job = requireJobDoc(snap);
    if (!job.strategyProposalId) throw new Error("strategy proposal is incomplete");
    const decision = await decideStrategyProposal(tx, job.strategyProposalId, input);
    const strategyOnly = job.config.intake && ["establish_strategy", "revise_strategy"].includes(job.config.intake.action) && (!job.config.sourceManifestId || !job.config.desiredOutputs.length);
    const result = strategyOnly && decision.approval.decision === "approved" ? { ...decision, nextStage: "complete" as const, terminalOutcome: "succeeded" as const } : decision;
    if (result.replayed) return { ...result, outboxId: undefined };
    if (job.stage !== "awaiting_strategy_approval") throw new Error("strategy is not awaiting approval");
    const update: Record<string, unknown> = {
      stage: result.nextStage,
      status: result.nextStage === "complete" ? "complete" : "running",
      updatedAt: new Date().toISOString(),
      ...(result.strategyRef ? { strategyRef: result.strategyRef } : {}),
    };
    if (result.nextStage === "strategize") {
      update.strategyRevision = result.nextRevision;
      update.strategyRevisionFeedback = result.approval.feedback;
    }
    if (result.nextStage === "complete") update.terminalOutcome = result.approval.decision === "approved" ? "succeeded" : "rejected";
    tx.patch(ref, update);
    let outboxId: string | undefined;
    if (result.nextStage === "plan" || result.nextStage === "strategize") {
      const attempt = result.nextStage === "strategize" ? 1 : 0;
      outboxId = stageOutboxId(jobId, result.nextStage, attempt);
      tx.insert(stageOutboxRef(outboxId), {
        id: outboxId, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
        jobId, stage: result.nextStage, attempt, completedStage: "awaiting_strategy_approval",
        note: result.nextStage === "plan" ? "strategy approved; editorial planning dispatched" : "strategy revision requested",
        ...stageOutboxDurability(outboxId, jobId, result.nextStage, attempt, "awaiting_strategy_approval"),
        state: "pending", createdAt: new Date().toISOString(),
      } satisfies StageOutboxRecord);
    }
    return { ...result, outboxId };
  });
}

export async function saveActions(jobId: string, actions: PlannedAction[]) {
  await awsRepository().patch(jobRef(jobId), {
    actions,
    updatedAt: new Date().toISOString(),
  });
}

export async function recordApproval(
  jobId: string,
  actionId: string,
  decision: "approved" | "rejected",
  expectedPayloadDigest: string,
  actor: ApprovalActor,
): Promise<PlannedAction> {
  return db().atomic(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.read(ref);
    const job = requireJobDoc(snap);
    const action = job.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`action ${actionId} not found on job ${jobId}`);
    const payloadDigest = actionPayloadDigest(action);
    if (payloadDigest !== expectedPayloadDigest) throw new Error("approval payload changed");
    if (action.approvalState !== "pending") {
      throw new Error(
        `action ${actionId} approval state is '${action.approvalState}', expected 'pending'`,
      );
    }
    action.approvalState = decision;
    action.state = decision === "approved" ? "planned" : "skipped";
    const decidedAt = new Date().toISOString();
    const traceId = currentTraceId();
    const decisionRef = recordKey(partition(ref.path + "/" + APPROVAL_DECISIONS).partition + "/" + actionId);
    tx.insert(decisionRef, {
      id: actionId,
      jobId,
      actionId,
      decision,
      payloadDigest,
      ...actor,
      operationId: `${jobId}:approval:${actionId}`,
      traceId,
      decidedAt,
    } satisfies ApprovalDecision);
    tx.patch(ref, {
      actions: job.actions,
      updatedAt: decidedAt,
    });
    return action;
  });
}

export async function listApprovalDecisions(jobId: string): Promise<Array<Omit<ApprovalDecision, "authenticationId">>> {
  const snaps = await awsRepository().query(ordered(partition(jobRef(jobId).path + "/" + APPROVAL_DECISIONS), "decidedAt", "asc"));
  return snaps.rows.map((doc) => {
    const decision = { ...(doc.value as unknown as ApprovalDecision) } as Partial<ApprovalDecision>;
    delete decision.authenticationId;
    return decision;
  }) as Array<Omit<ApprovalDecision, "authenticationId">>;
}

export async function markActionExecuted(
  jobId: string,
  actionId: string,
  state: PlannedAction["state"],
) {
  const ref = jobRef(jobId);
  await db().atomic(async (tx) => {
    const snap = await tx.read(ref);
    const job = requireJobDoc(snap);
    const action = job.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    action.state = state;
    tx.patch(ref, {
      actions: job.actions,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function writeReceipt(receipt: Receipt): Promise<void> {
  await awsRepository().put(recordKey(partition(recordKey(tenantCollection(JOBS).partition + "/" + receipt.jobId).path + "/" + RECEIPTS).partition + "/" + receipt.id), receipt);
}

export async function finalizeEffectReceipt(
  receipt: Receipt,
  claimToken: string,
): Promise<{ duplicate: boolean; receipt: Receipt }> {
  const ref = jobRef(receipt.jobId);
  const claimRef = recordKey(partition(ref.path + "/" + EFFECT_CLAIMS).partition + "/" + receipt.idempotencyKey);
  return db().atomic(async (tx) => {
    const [jobSnap, claimSnap] = await Promise.all([tx.read(ref), tx.read(claimRef)]);
    const job = requireJobDoc(jobSnap);
    if (!claimSnap.present) throw new Error("effect receipt has no durable claim");
    const claim = claimSnap.value as unknown as EffectClaim;
    if (
      claim.actionId !== receipt.actionId
      || claim.actionType !== receipt.actionType
      || claim.operationId !== receipt.operationId
      || claim.traceId !== receipt.traceId
    ) {
      throw new Error("effect receipt does not match its durable claim");
    }
    const decision = decideEffectFinalization(claim, claimToken, receipt.id, receipt.outcome);
    if (decision.duplicate) {
      const originalSnap = await tx.read(recordKey(partition(ref.path + "/" + RECEIPTS).partition + "/" + decision.receiptId));
      if (!originalSnap.present) throw new Error("finalized effect claim receipt is missing");
      return { duplicate: true, receipt: originalSnap.value as unknown as Receipt };
    }
    const action = job.actions.find((candidate) => candidate.id === receipt.actionId);
    if (!action) throw new Error(`action ${receipt.actionId} not found`);
    if (action.state !== "planned") throw new Error(`action ${receipt.actionId} is not awaiting finalization`);
    action.state = receipt.outcome === "failed" || receipt.outcome === "rejected" ? "failed" : "executed";
    tx.insert(recordKey(partition(ref.path + "/" + RECEIPTS).partition + "/" + receipt.id), receipt);
    tx.put(claimRef, decision.claim);
    tx.patch(ref, { actions: job.actions, updatedAt: receipt.performedAt });
    return { duplicate: false, receipt };
  });
}

export async function listReceipts(jobId: string): Promise<Receipt[]> {
  const snaps = await awsRepository().query(ordered(partition(jobRef(jobId).path + "/" + RECEIPTS), "performedAt", "asc"));
  return snaps.rows.map((d) => d.value as unknown as Receipt);
}

export interface VerifiedPublication {
  publicationId: string;
  jobId: string;
  actionId: string;
  platform: string;
  text: string;
  canonicalUrl: string;
  publishedAt: string;
  receiptId: string;
  verificationId: string;
}

export async function listVerifiedPublications(
  query: string,
  limit = 10,
): Promise<VerifiedPublication[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const jobs = await listJobs(100);
  const publications: VerifiedPublication[] = [];
  for (const job of jobs) {
    const jobData = job as Job & {
      actions: PlannedAction[];
      verifications: VerificationResult[];
    };
    const receipts = await listReceipts(job.id);
    for (const receipt of receipts) {
      if (receipt.actionType !== "publish_x_post" || receipt.outcome !== "applied") continue;
      const verification = (jobData.verifications ?? []).find(
        (candidate) => candidate.receiptId === receipt.id && candidate.actionId === receipt.actionId,
      );
      if (!verification || !verification.verified) continue;
      const canonicalUrl = typeof receipt.detail.url === "string" ? receipt.detail.url : "";
      if (!canonicalUrl.startsWith("https://x.com/")) continue;
      const action = jobData.actions.find((candidate) => candidate.id === receipt.actionId);
      const actionText = action && typeof (action.payload as { text?: unknown }).text === "string"
        ? (action.payload as { text: string }).text
        : "";
      const text = actionText || action?.title || "";
      if (!text.toLowerCase().includes(normalized)) continue;
      publications.push({
        publicationId: String(receipt.detail.id ?? receipt.id),
        jobId: job.id,
        actionId: receipt.actionId,
        platform: ("x"),
        text,
        canonicalUrl,
        publishedAt: receipt.performedAt,
        receiptId: receipt.id,
        verificationId: verification.id,
      });
    }
  }
  return publications
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, Math.max(1, Math.min(limit, 10)));
}

export async function findReceiptByIdempotencyKey(
  jobId: string,
  key: string,
): Promise<Receipt | null> {
  const snaps = await awsRepository().query(limited(where(partition(jobRef(jobId).path + "/" + RECEIPTS), "idempotencyKey", "==", key), 1));
  return snaps.empty ? null : (snaps.rows[0].value as unknown as Receipt);
}

export async function writeReplayObservation(observation: ReplayObservation): Promise<void> {
  await awsRepository().put(recordKey(partition(jobRef(observation.jobId).path + "/" + REPLAY_OBSERVATIONS).partition + "/" + observation.id), observation);
}

export async function listReplayObservations(jobId: string): Promise<ReplayObservation[]> {
  const snaps = await awsRepository().query(ordered(partition(jobRef(jobId).path + "/" + REPLAY_OBSERVATIONS), "attemptedAt", "asc"));
  return snaps.rows.map((doc) => doc.value as unknown as ReplayObservation);
}

export async function claimEffect(input: EffectClaimInput): Promise<EffectClaimOutcome> {
  const ref = jobRef(input.jobId);
  const claimRef = recordKey(partition(ref.path + "/" + EFFECT_CLAIMS).partition + "/" + input.idempotencyKey);
  const approvalRef = recordKey(partition(ref.path + "/" + APPROVAL_DECISIONS).partition + "/" + input.actionId);
  return db().atomic(async (tx) => {
    const [jobSnap, claimSnap, approvalSnap] = await Promise.all([
      tx.read(ref), tx.read(claimRef), tx.read(approvalRef),
    ]);
    const job = requireJobDoc(jobSnap);
    const action = job.actions.find((candidate) => candidate.id === input.actionId);
    if (!action) throw new Error(`action ${input.actionId} not found on job ${input.jobId}`);
    if (action.type !== input.actionType) throw new Error("effect claim action type mismatch");
    if (action.requiresApproval) {
      const approval = approvalSnap.present ? approvalSnap.value as unknown as ApprovalDecision : null;
      if (
        !approval
        || approval.jobId !== input.jobId
        || approval.actionId !== input.actionId
        || approval.decision !== "approved"
        || approval.payloadDigest !== actionPayloadDigest(action)
        || !["cognito_operator", "telegram_operator"].includes(approval.actorType)
      ) {
        throw new Error("effect claim requires a durable approval decision");
      }
      const expectedChannel = approval.actorType === "cognito_operator" ? "dashboard" : "telegram";
      if (
        !approval.actorSubjectId
        || !approval.authenticationId
        || approval.channel !== expectedChannel
        || approval.operationId !== `${input.jobId}:approval:${input.actionId}`
        || !/^[a-f0-9]{32}$/.test(approval.traceId)
        || approval.traceId === "0".repeat(32)
        || !Number.isFinite(Date.parse(approval.decidedAt))
      ) {
        throw new Error("effect claim requires authenticated approval provenance");
      }
    }

    const existing = claimSnap.present ? claimSnap.value as unknown as EffectClaim : null;
    const decision = decideEffectClaim(existing, input);
    if (decision.outcome !== "execute") return decision;
    const admission = decideWorkAdmission(job.controlState);
    if (admission.outcome !== "execute") return admission;
    if (action.state !== "planned") {
      throw new Error(`action ${input.actionId} is not executable from state '${action.state}'`);
    }
    if (action.requiresApproval && action.approvalState !== "approved") {
      throw new Error(`action ${input.actionId} has no durable approval`);
    }
    if (claimSnap.present) tx.put(claimRef, decision.claim);
    else tx.insert(claimRef, decision.claim);
    return decision;
  });
}

export async function getEffectClaim(jobId: string, idempotencyKey: string): Promise<EffectClaim | null> {
  const snap = await awsRepository().read(recordKey(partition(jobRef(jobId).path + "/" + EFFECT_CLAIMS).partition + "/" + idempotencyKey));
  return snap.present ? snap.value as unknown as EffectClaim : null;
}

export async function listEffectClaims(jobId: string): Promise<EffectClaim[]> {
  const snaps = await awsRepository().query(ordered(partition(jobRef(jobId).path + "/" + EFFECT_CLAIMS), "claimedAt", "asc"));
  return snaps.rows.map((doc) => doc.value as unknown as EffectClaim);
}

export async function saveVerifications(
  jobId: string,
  results: VerificationResult[],
) {
  const ref = jobRef(jobId);
  await db().atomic(async (tx) => {
    const [jobSnap, ...receiptSnaps] = await Promise.all([
      tx.read(ref),
      ...results.map((result) => tx.read(recordKey(partition(ref.path + "/" + RECEIPTS).partition + "/" + result.receiptId))),
    ]);
    const job = requireJobDoc(jobSnap);
    const seenActions = new Set<string>();
    const seenReceipts = new Set<string>();
    results.forEach((result, index) => {
      if (seenActions.has(result.actionId) || seenReceipts.has(result.receiptId)) {
        throw new Error("verification submission contains duplicate lineage");
      }
      seenActions.add(result.actionId);
      seenReceipts.add(result.receiptId);
      const receiptSnap = receiptSnaps[index];
      if (!receiptSnap.present) throw new Error("verification receipt not found");
      const receipt = receiptSnap.value as unknown as Receipt;
      const action = job.actions.find((candidate) => candidate.id === result.actionId);
      if (
        !action
        || action.state !== "executed"
        || receipt.jobId !== jobId
        || receipt.actionId !== result.actionId
        || receipt.outcome !== "applied"
      ) {
        throw new Error("verification does not match an applied job action");
      }
      if (result.operationId === receipt.operationId) {
        throw new Error("verification requires a distinct readback operation");
      }
      if (Date.parse(result.checkedAt) < Date.parse(receipt.performedAt)) {
        throw new Error("verification predates its receipt");
      }
      if (action.type === "publish_x_post") {
        if (receipt.actionType !== "publish_x_post") {
          throw new Error("verification does not match an applied job action");
        }
        const publishedPostId = receipt.detail.id;
        if (typeof publishedPostId !== "string" || !publishedPostId.trim()) {
          throw new Error("applied X publish receipt is missing post id");
        }
        if (result.target !== `x:${publishedPostId}`) {
          throw new Error("X verification target does not match applied receipt post id");
        }
      }
      if (action.type === "publish_linkedin_post") {
        if (receipt.actionType !== action.type || typeof receipt.detail.id !== "string" || result.target !== `linkedin:${receipt.detail.id}`) throw new Error("LinkedIn verification target does not match applied receipt post id");
      }
      if (action.type === "publish_x_thread") {
        if (receipt.actionType !== action.type || !Array.isArray(receipt.detail.postIds) || !receipt.detail.postIds.length || result.target !== `x-thread:${receipt.detail.postIds[0]}`) throw new Error("X thread verification target does not match applied receipt post id");
      }
      const expectedMethod = ["publish_x_post", "publish_x_thread", "publish_linkedin_post"].includes(receipt.actionType)
        ? "official_api_readback"
        : "artifact_digest_reread";
      if (result.method !== expectedMethod) throw new Error("verification method does not match action type");
      if (result.verified && (
        !receipt.artifact?.digest
        || result.evidence.digest !== receipt.artifact.digest
      )) {
        throw new Error("verified evidence digest does not match receipt");
      }
    });
    tx.patch(ref, {
      verifications: results,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function savePacket(jobId: string, packet: EvidencePacket) {
  await awsRepository().patch(jobRef(jobId), {
    packet,
    updatedAt: new Date().toISOString(),
  });
}

export async function saveLearnings(
  jobId: string,
  engagement: Engagement[],
  learnings: Learnings,
  terminalOutcome: NonNullable<Job["terminalOutcome"]>,
): Promise<void> {
  await awsRepository().patch(jobRef(jobId), {
    engagement,
    learnings,
    status: "complete",
    stage: "complete",
    terminalOutcome,
    retentionDeleteAfter: retentionDeadline(),
    updatedAt: new Date().toISOString(),
  });
  await reconcilePlannedExecution(jobId);
}

export interface PriorInsight {
  jobId: string;
  actionId: string | null;
  postId: string | null;
  checkedAt: string | null;
  durableEvidenceRef: string | null;
  metrics: {
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    impressions?: number;
  } | null;
  text: string | null;
  textAvailability: "verified_action_payload_digest" | "unavailable";
  availability: "available" | "unavailable";
  unavailableReason?: "missing_identity" | "missing_action" | "invalid_publish_action" | "missing_or_invalid_checked_at" | "missing_metrics" | "unverified_publication" | "post_identity_mismatch" | "stale_verification";
}

function metricValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function engagementMetrics(engagement: Engagement): PriorInsight["metrics"] {
  const likes = metricValue(engagement.likes);
  const replies = metricValue(engagement.replies);
  const reposts = metricValue(engagement.reposts);
  const quotes = metricValue(engagement.quotes);
  const impressions = engagement.impressions === undefined ? undefined : metricValue(engagement.impressions);
  if (likes === null || replies === null || reposts === null || quotes === null || impressions === null) return null;
  return { likes, replies, reposts, quotes, ...(impressions === undefined ? {} : { impressions }) };
}

function priorInsightUnavailable(
  jobId: string,
  engagement: Engagement,
  unavailableReason: NonNullable<PriorInsight["unavailableReason"]>,
): PriorInsight {
  return {
    jobId,
    actionId: typeof engagement.actionId === "string" && engagement.actionId ? engagement.actionId : null,
    postId: typeof engagement.postId === "string" && engagement.postId ? engagement.postId : null,
    checkedAt: null,
    durableEvidenceRef: null,
    metrics: null,
    text: null,
    textAvailability: "unavailable",
    availability: "unavailable",
    unavailableReason,
  };
}

/** Builds the typed, verification-bound performance observations exposed to agents. */
export function priorInsightsFromJob(jobId: string, data: Pick<JobDoc, "actions" | "verifications"> & { engagement?: Engagement[] }): PriorInsight[] {
  return (data.engagement ?? []).map((engagement) => {
    if (typeof engagement.actionId !== "string" || !engagement.actionId || typeof engagement.postId !== "string" || !engagement.postId) {
      return priorInsightUnavailable(jobId, engagement, "missing_identity");
    }
    const action = (data.actions ?? []).find((candidate) => candidate.id === engagement.actionId);
    if (!action) return priorInsightUnavailable(jobId, engagement, "missing_action");
    if (action.type !== "publish_x_post" || action.state !== "executed") {
      return priorInsightUnavailable(jobId, engagement, "invalid_publish_action");
    }
    const checkedAt = typeof engagement.checkedAt === "string" && !Number.isNaN(Date.parse(engagement.checkedAt))
      ? engagement.checkedAt
      : null;
    if (!checkedAt) return priorInsightUnavailable(jobId, engagement, "missing_or_invalid_checked_at");
    const metrics = engagementMetrics(engagement);
    if (!metrics) return priorInsightUnavailable(jobId, engagement, "missing_metrics");
    const verifiedActionVerifications = (data.verifications ?? []).filter((verification) => (
      verification.actionId === engagement.actionId
      && verification.verified
      && verification.method === "official_api_readback"
      && typeof verification.evidence?.url === "string"
      && verification.evidence.url.length > 0
      && typeof verification.evidence.digest === "string"
      && verification.evidence.digest.length > 0
    ));
    const matchingVerifications = verifiedActionVerifications.filter((verification) => (
      verification.target === `x:${engagement.postId}`
    ));
    if (!matchingVerifications.length) {
      return priorInsightUnavailable(
        jobId,
        engagement,
        verifiedActionVerifications.length ? "post_identity_mismatch" : "unverified_publication",
      );
    }
    const verification = matchingVerifications.find((candidate) => (
      !Number.isNaN(Date.parse(candidate.checkedAt))
      && Date.parse(candidate.checkedAt) <= Date.parse(checkedAt)
    ));
    if (!verification) {
      return priorInsightUnavailable(jobId, engagement, "stale_verification");
    }
    const text = typeof action.payload.text === "string"
      && createHash("sha256").update(action.payload.text).digest("hex") === verification.evidence.digest
      ? action.payload.text
      : null;
    return {
      jobId,
      actionId: engagement.actionId,
      postId: engagement.postId,
      checkedAt,
      durableEvidenceRef: verification.evidence.url,
      metrics,
      text,
      textAvailability: text === null ? "unavailable" : "verified_action_payload_digest",
      availability: "available",
    };
  });
}

export async function listRecentEngagement(limit = 20): Promise<PriorInsight[]> {
  const { learningInsights } = await import("./learning/repository");
  return (await learningInsights()).topPosts.slice(0, limit);
}

export async function markFailed(
  failure: import("./contracts").FailureSubmission,
) {
  await awsRepository().patch(jobRef(failure.jobId), {
    status: failure.retryable ? "running" : "failed",
    failure: {
      stage: failure.stage,
      category: failure.category,
      code: failure.code,
      publicMessage: failure.publicMessage,
      retryable: failure.retryable,
      operationId: failure.operationId,
      traceId: failure.traceId,
      attempt: failure.attempt,
      maxAttempts: failure.maxAttempts,
      details: failure.details,
      error: failure.publicMessage,
      permanent: !failure.retryable,
      at: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
    ...(!failure.retryable ? { retentionDeleteAfter: retentionDeadline() } : {}),
  });
  await reconcilePlannedExecution(failure.jobId);
}

/** Critical notification for permanent pipeline failures (fire-and-forget). */
export async function notifyPermanentFailure(
  jobId: string,
  stage: Stage,
  error: string,
): Promise<void> {
  await createNotification({
    kind: "job_failed",
    title: "Job failed",
    body: `Job ${jobId.slice(0, 12)} failed permanently at '${stage}': ${error.slice(0, 160)}`,
    severity: "critical",
    refType: "job",
    refId: jobId,
    href: "/dashboard/monitoring",
    createdAt: new Date().toISOString(),
  });
}

export async function appendEvent(
  jobId: string,
  stage: Stage,
  message: string,
  actor: StageEvent["actor"],
  metadata: { operationId?: string; traceId?: string; transportMessageId?: string; activity?: StageEvent["activity"] } = {},
): Promise<void> {
  const activity = metadata.activity ? agentActivitySchema.parse(metadata.activity) : undefined;
  const id = newId();
  const traceId = metadata.traceId ?? currentTraceId();
  const operationId = metadata.operationId ?? `${jobId}:${stage}:${id}`;
  const eventMetadata = {
    operationId,
    traceId,
    ...(metadata.transportMessageId ? { transportMessageId: metadata.transportMessageId } : {}),
    ...(activity ? { activity } : {}),
  };
  await awsRepository().put(recordKey(partition(jobRef(jobId).path + "/" + EVENTS).partition + "/" + id), {
      jobId,
      at: new Date().toISOString(),
      stage,
      message,
      actor,
      ...eventMetadata,
    } satisfies Omit<StageEvent, "id" | "at"> & { at: unknown });
  // Denormalized within the workspace so monitoring remains tenant-isolated.
  await awsRepository().put(recordKey(tenantCollection(EVENT_LOG).partition + "/" + id), { jobId, at: new Date().toISOString(), stage, message, actor, ...eventMetadata });
}

export interface EventLogEntry {
  id: string;
  jobId: string;
  at: string | null;
  stage: string;
  message: string;
  actor: string;
  operationId: string;
  traceId: string;
  transportMessageId?: string;
  activity?: StageEvent["activity"];
}

export async function listEventLog(limit = 300): Promise<EventLogEntry[]> {
  const snaps = await awsRepository().query(limited(ordered(tenantCollection(EVENT_LOG), "at", "desc"), limit));
  return snaps.rows.map((d) => {
    const data = d.value as unknown as Omit<EventLogEntry, "id" | "at"> & { at?: string };
    return {
      id: d.id,
      jobId: data.jobId,
      at: data.at ?? null,
      stage: data.stage,
      message: data.message,
      actor: data.actor,
      operationId: data.operationId,
      traceId: data.traceId,
      ...(data.transportMessageId ? { transportMessageId: data.transportMessageId } : {}),
      ...(data.activity ? { activity: data.activity } : {}),
    };
  });
}

export async function listEvents(
  jobId: string,
  limit = 200,
): Promise<Array<Omit<StageEvent, "at"> & { at: string | null }>> {
  const snaps = await awsRepository().query(limited(ordered(partition(jobRef(jobId).path + "/" + EVENTS), "at", "asc"), limit));
  return snaps.rows.map((d) => {
    const data = d.value as unknown as Omit<StageEvent, "id" | "at"> & { at?: string };
    return {
      id: d.id,
      jobId,
      at: data.at ?? null,
      stage: data.stage,
      message: data.message,
      actor: data.actor,
      operationId: data.operationId,
      traceId: data.traceId,
      ...(data.transportMessageId ? { transportMessageId: data.transportMessageId } : {}),
      ...(data.activity ? { activity: data.activity } : {}),
    };
  });
}
