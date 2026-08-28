import { Firestore, FieldValue } from "@google-cloud/firestore";
import { createHash } from "node:crypto";
import { canonicalJson } from "./recordReplay/integrity";
import type {
  EvidencePacket,
  Engagement,
  Job,
  JobConfig,
  Learnings,
  JobBudget,
  PlannedAction,
  Receipt,
  PostDraft,
  Stage,
  StageEvent,
  VerificationResult,
  UsageRecord,
  ApprovalDecision,
  ReplayObservation,
  EffectClaim,
  EffectClaimInput,
  EffectClaimOutcome,
  DraftWorkflowResult,
} from "./types";
import { applyFinalizedUsage, applyReleasedReservation, applyReservation, canReserve, exceedsApprovalThreshold } from "./costs";
import { markReservationFinalized, markReservationReleased, markReservationUncertain, type CostReservationState } from "./costReservations";
import { parseBudgetConfig } from "./config";
import { actionPayloadDigest, newId } from "./idempotency";
import type { ApprovalActor } from "./decisions";
import { applyStrategyDecision, assertStrategyProposalRevision, validatePersistedStrategy, validateStrategySearchGrounding, type StrategyDecisionInput } from "./strategyApproval";
import { assertEditorialPlanSubmission, assertSelectedProductionAuthority, editorialDraftCompletionPatch, editorialPlanDigest, editorialPlanEvidenceLineage, editorialPlanningSnapshotDigest, isMatchingCompletedProduction } from "./editorialPlan";
import { buildEditorialPlanningSnapshot } from "./editorialPlanning";
import {
  assertResourceWorkspace,
  currentTenant,
  tenantCollectionPath,
  tenantSubjectId,
} from "./tenancy";
import { chatScopeKey, retentionPlan, type ChatSurface } from "./chatHistory";
import { currentTraceId } from "./telemetry";
import { decideEffectClaim, decideEffectFinalization } from "./effectClaims";
import { decideTelegramNonceClaim, telegramDigest, type TelegramWebhookRoute } from "./telegramWebhook";
import { connectionEnvelopeKey, decryptSecret, encryptSecret, type SecretEnvelope } from "./secretEnvelope";
import { omitUndefinedFields } from "./firestoreValues";
import { claimStageExecution as decideStageClaim, finalizeStageExecution, type StageExecution, type StageClaimResult } from "./stageExecutions";
import { decideConnectionRefresh, type ConnectionRefreshState } from "./connectionRefresh";
import { deleteArtifactUri, deleteWorkspaceArtifactUri } from "./storage";
import { agentActivitySchema } from "./contracts";
import { deletionTombstone, retentionDeadline, type DeletionPlan, type WorkspaceDeletionPlan } from "./lifecycle";
import { decideTickClaim, type TickClaimState } from "./tickClaims";
import {
  decideStageOutboxClaim,
  finalizeStageOutbox,
  releaseStageOutboxClaim,
  normalizeStageOutboxRecord,
  type StageOutboxRecord,
} from "./stageOutbox";
import {
  FirestoreOperationPersistence,
  OperationStore,
  type OperationRecoveryPage,
} from "./operationStore";
import {
  operationIdForStage,
  type CreateOperationInput,
  type FinalizeOperationInput,
  type OperationClaimInput,
  type OperationClaimResult,
  type OperationFence,
  type OperationRecord,
} from "./operations";
import { EventInboxStore, type DurableEventClaimInput } from "./eventInboxStore";
import type { EventInboxClaimResult, EventInboxRecord } from "./eventInbox";

let client: Firestore | null = null;

export function db(): Firestore {
  if (!client) {
    client = new Firestore();
  }
  return client;
}

function durableOperations(): OperationStore {
  return new OperationStore(new FirestoreOperationPersistence(db()));
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
  const snaps = await db().collection("workspaces").get();
  return snaps.docs
    .filter((doc) => !doc.get("disabledAt"))
    .map((doc) => ({
      workspaceId: doc.id,
      brandId: String(doc.get("defaultBrandId") ?? ""),
    }))
    .filter((scope) => Boolean(scope.brandId));
}

interface JobDoc extends Omit<Job, "id"> {
  transcriptSegments?: Array<{ id: string; startSec: number; endSec: number; text: string }>;
  transcriptLanguage?: string;
  drafts?: PostDraft[];
  productionTrace?: DraftWorkflowResult;
  productionTraceDigest?: string;
  contentPack?: { markdown: string; digest: string; generatedAt: string };
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
  return db().collection(tenantCollectionPath(currentTenant(), name));
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
  completedStage?: Stage,
): Pick<StageOutboxRecord, "schemaVersion" | "sourceEventId" | "operationId" | "correlationId" | "causationId" | "publishAttempt"> {
  return {
    schemaVersion: 1,
    sourceEventId: `stage-outbox:${id}`,
    operationId: operationIdForStage(jobId, stage),
    correlationId: `job:${jobId}`,
    ...(completedStage ? { causationId: operationIdForStage(jobId, completedStage) } : {}),
    publishAttempt: 0,
  };
}

function stageOutboxRef(id: string) {
  return tenantCollection(STAGE_OUTBOX).doc(id);
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
  await db().runTransaction(async (tx) => {
    const [jobSnapshot, existing] = await Promise.all([tx.get(jobRef(jobId)), tx.get(ref)]);
    const job = requireJobDoc(jobSnapshot);
    if (job.stage !== stage) throw new Error(`cannot enqueue stage '${stage}' while job is '${job.stage}'`);
    if (existing.exists) return;
    tx.create(ref, {
      id, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
      jobId, stage, attempt, ...metadata,
      ...stageOutboxDurability(id, jobId, stage, metadata.completedStage),
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
  const id = stageOutboxId(jobId, nextStage, 0);
  const ref = stageOutboxRef(id);
  const tenant = currentTenant();
  await db().runTransaction(async (tx) => {
    const [jobSnapshot, existing] = await Promise.all([tx.get(jobRef(jobId)), tx.get(ref)]);
    const job = requireJobDoc(jobSnapshot);
    if (job.stage === nextStage && existing.exists) return;
    if (job.stage !== completedStage) {
      throw new Error(`cannot complete stage '${completedStage}' while job is '${job.stage}'`);
    }
    tx.update(jobRef(jobId), {
      stage: nextStage,
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    tx.create(ref, {
      id, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
      jobId, stage: nextStage, attempt: 0, completedStage, note,
      ...stageOutboxDurability(id, jobId, nextStage, completedStage),
      state: "pending", createdAt: new Date().toISOString(),
    } satisfies StageOutboxRecord);
  });
  return id;
}

export async function listDispatchableStageOutbox(limit = 20): Promise<StageOutboxRecord[]> {
  const tenant = currentTenant();
  const snapshot = await tenantCollection(STAGE_OUTBOX)
    .where("state", "in", ["pending", "claimed"])
    .limit(100)
    .get();
  return snapshot.docs
    .map((doc) => doc.data() as StageOutboxRecord)
    .filter((record) => record.workspaceId === tenant.workspaceId && record.brandId === tenant.brandId)
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export async function claimStageOutbox(
  id: string,
  claimTokenDigest: string,
  now = new Date(),
): Promise<ReturnType<typeof decideStageOutboxClaim>> {
  const ref = stageOutboxRef(id);
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new Error("stage outbox record not found");
    const record = normalizeStageOutboxRecord(snapshot.data() as StageOutboxRecord);
    assertResourceWorkspace(currentTenant(), record);
    const decision = decideStageOutboxClaim(record, claimTokenDigest, now);
    if (decision.outcome === "publish") tx.set(ref, decision.record);
    return decision;
  });
}

export async function releaseStageOutbox(
  id: string,
  claimTokenDigest: string,
): Promise<void> {
  const ref = stageOutboxRef(id);
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return;
    const record = normalizeStageOutboxRecord(snapshot.data() as StageOutboxRecord);
    assertResourceWorkspace(currentTenant(), record);
    tx.set(ref, releaseStageOutboxClaim(record, claimTokenDigest));
  });
}

export async function finalizeStageOutboxPublish(
  id: string,
  claimTokenDigest: string,
  pubsubMessageId: string,
  now = new Date(),
): Promise<void> {
  const ref = stageOutboxRef(id);
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new Error("stage outbox record not found");
    const current = normalizeStageOutboxRecord(snapshot.data() as StageOutboxRecord);
    assertResourceWorkspace(currentTenant(), current);
    const finalized = finalizeStageOutbox(current, claimTokenDigest, pubsubMessageId, now);
    tx.set(ref, finalized);
    if (current.completedStage && current.note) {
      const event = {
        jobId: current.jobId,
        at: FieldValue.serverTimestamp(),
        stage: current.completedStage,
        message: current.note,
        actor: "system" as const,
        operationId: `${current.jobId}:${current.completedStage}:${id}`,
        traceId: currentTraceId(),
        pubsubMessageId,
      };
      tx.set(jobRef(current.jobId).collection(EVENTS).doc(`outbox-${id}`), event);
      tx.set(tenantCollection(EVENT_LOG).doc(`outbox-${id}`), event);
    }
  });
}

// ---------- content items ----------

export function contentItemRef(id: string) {
  return tenantCollection(CONTENT_ITEMS).doc(id);
}

export async function createContentItem(item: import("./types").ContentItem): Promise<void> {
  await contentItemRef(item.id).set(item);
}

export async function getContentItem(id: string) {
  const snap = await contentItemRef(id).get();
  return snap.exists ? (snap.data() as import("./types").ContentItem) : null;
}

export async function updateContentItem(
  id: string,
  patch: Partial<import("./types").ContentItem>,
): Promise<void> {
  // Callers use `undefined` fields (e.g. failureReason) to clear values, but
  // Firestore rejects undefined — strip them so merges stay valid.
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  await contentItemRef(id).set({ ...clean, updatedAt: new Date().toISOString() }, { merge: true });
}

export function deleteFirestoreField(): FirebaseFirestore.FieldValue {
  return FieldValue.delete();
}

export async function saveCalendarSyncIfUnchanged(
  id: string,
  expectedUpdatedAt: string,
  sync: import("./types").GoogleCalendarSync,
): Promise<import("./types").GoogleCalendarSync> {
  const ref = contentItemRef(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("content item disappeared during calendar synchronization");
    const current = snap.data() as import("./types").ContentItem;
    const persisted = current.updatedAt === expectedUpdatedAt || sync.status === "removed"
      ? sync
      : { ...sync, status: "update_required" as const };
    tx.set(ref, { googleCalendarSync: persisted, updatedAt: new Date().toISOString() }, { merge: true });
    return persisted;
  });
}

export async function listContentItems(): Promise<import("./types").ContentItem[]> {
  const snaps = await tenantCollection(CONTENT_ITEMS)
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();
  return snaps.docs.map((d) => d.data() as import("./types").ContentItem);
}

export async function getOrCreateEditorialPlanningSnapshot(jobId: string) {
  const job = await getJob(jobId);
  const revision = job.editorialPlanRevision ?? 1;
  const expectedId = `planning-${jobId}-v${revision}`;
  if (job.editorialPlanningSnapshot?.snapshotId === expectedId && job.editorialPlanningSnapshotDigest) {
    if (editorialPlanningSnapshotDigest(job.editorialPlanningSnapshot) !== job.editorialPlanningSnapshotDigest) {
      throw new Error("persisted editorial planning snapshot digest mismatch");
    }
    return { snapshot: job.editorialPlanningSnapshot, digest: job.editorialPlanningSnapshotDigest };
  }
  const candidate = buildEditorialPlanningSnapshot(job, await listContentItems());
  const digest = editorialPlanningSnapshotDigest(candidate);
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
    const current = requireJobDoc(snap);
    if ((current.editorialPlanRevision ?? 1) !== revision || current.strategyDigest !== job.strategyDigest) {
      throw new Error("editorial planning authority changed while snapshot was assembled");
    }
    if (current.editorialPlanningSnapshot?.snapshotId === expectedId && current.editorialPlanningSnapshotDigest) {
      if (editorialPlanningSnapshotDigest(current.editorialPlanningSnapshot) !== current.editorialPlanningSnapshotDigest) {
        throw new Error("persisted editorial planning snapshot digest mismatch");
      }
      return { snapshot: current.editorialPlanningSnapshot, digest: current.editorialPlanningSnapshotDigest };
    }
    if (current.stage !== "plan") throw new Error("job is not in editorial planning stage");
    tx.update(ref, {
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
  await tenantCollection(NOTIFICATIONS)
    .doc(id)
    .set({ ...n, id, createdAt: n.createdAt || new Date().toISOString() });
}

export async function listNotifications(limit = 100): Promise<import("./types").AppNotification[]> {
  const snaps = await tenantCollection(NOTIFICATIONS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => d.data() as import("./types").AppNotification);
}

export async function markNotificationRead(id: string): Promise<void> {
  await tenantCollection(NOTIFICATIONS).doc(id).update({ readAt: new Date().toISOString() });
}

export async function markAllNotificationsRead(): Promise<void> {
  const snaps = await tenantCollection(NOTIFICATIONS).where("readAt", "==", null).get();
  await Promise.all(snaps.docs.map((d) => d.ref.update({ readAt: new Date().toISOString() })));
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
  return tenantCollection(PROPOSALS).doc(id);
}

export async function getProposal(id: string): Promise<ContentProposal | null> {
  const snap = await proposalRef(id).get();
  return snap.exists ? (snap.data() as ContentProposal) : null;
}

export async function saveProposal(p: ContentProposal): Promise<void> {
  await proposalRef(p.id).set(p);
}

export async function listProposals(limit = 100): Promise<ContentProposal[]> {
  const snaps = await tenantCollection(PROPOSALS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => d.data() as ContentProposal);
}

export async function decideProposal(
  id: string,
  decision: "approved" | "rejected",
  patch: { jobId?: string } = {},
): Promise<void> {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await proposalRef(id).set(
    { status: decision, decidedAt: new Date().toISOString(), ...clean },
    { merge: true },
  );
}

// ---------- agent state (proactive check cadence bookkeeping) ----------

const AGENT_STATE = "agent_state";

export interface AgentStateDoc {
  lastRunAt?: string;
  data?: Record<string, unknown>;
  updatedAt: string;
}

export async function getAgentState(key: string): Promise<AgentStateDoc | null> {
  const snap = await tenantCollection(AGENT_STATE).doc(key).get();
  return snap.exists ? (snap.data() as AgentStateDoc) : null;
}

export async function setAgentState(key: string, patch: Partial<AgentStateDoc>): Promise<void> {
  await tenantCollection(AGENT_STATE)
    .doc(key)
    .set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function claimAgentTick(
  key: string,
  claimId: string,
  leaseSeconds: number,
  now = new Date(),
): Promise<boolean> {
  const ref = tenantCollection(AGENT_STATE).doc(key);
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const current = snapshot.exists && snapshot.get("claimId") ? {
      claimId: String(snapshot.get("claimId")),
      claimedAt: String(snapshot.get("claimedAt")),
      leaseUntil: String(snapshot.get("leaseUntil")),
    } satisfies TickClaimState : null;
    const decision = decideTickClaim(current, claimId, leaseSeconds, now);
    if (!decision.claimed) return false;
    tx.set(ref, {
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
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Google Calendar is not connected");
    const connection = snap.data() as ConnectionDoc;
    if (connection.calendarId) return { calendarId: connection.calendarId };
    if (connection.calendarProvisioning) {
      throw new Error(connection.calendarProvisioning.status === "uncertain"
        ? "Calendar provisioning outcome is uncertain; inspect Google Calendar before reconnecting"
        : "Calendar provisioning is already in progress");
    }
    const claimId = newId();
    tx.set(ref, { calendarProvisioning: { status: "claimed", claimId, at: new Date().toISOString() } }, { merge: true });
    return { claimId };
  });
}

export async function completeCalendarProvisioning(claimId: string, calendar: { id: string; summary: string }): Promise<void> {
  const ref = connectionRef("google-calendar");
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const connection = snap.data() as ConnectionDoc | undefined;
    if (connection?.calendarProvisioning?.claimId !== claimId) throw new Error("calendar provisioning claim was lost");
    tx.set(ref, { calendarId: calendar.id, calendarTitle: calendar.summary, calendarProvisionedAt: new Date().toISOString(), calendarProvisioning: FieldValue.delete() }, { merge: true });
  });
}

export async function markCalendarProvisioningUncertain(claimId: string): Promise<void> {
  const ref = connectionRef("google-calendar");
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const connection = snap.data() as ConnectionDoc | undefined;
    if (connection?.calendarProvisioning?.claimId === claimId) {
      tx.set(ref, { calendarProvisioning: { status: "uncertain", claimId, at: new Date().toISOString() } }, { merge: true });
    }
  });
}

export function connectionRef(platform: string) {
  return tenantCollection(CONNECTIONS).doc(platform);
}

export async function getConnection(platform: string): Promise<ConnectionDoc | null> {
  const snap = await connectionRef(platform).get();
  if (!snap.exists) return null;
  return decodeConnection(snap.data() as StoredConnectionDoc);
}

export async function saveConnection(conn: ConnectionDoc): Promise<void> {
  await connectionRef(conn.platform).set(encodeConnection(conn));
}

export type ConnectionRefreshClaim =
  | { outcome: "fresh"; connection: ConnectionDoc }
  | { outcome: "refresh"; claimId: string; connection: ConnectionDoc }
  | { outcome: "in_progress" }
  | { outcome: "uncertain" };

export async function claimConnectionTokenRefresh(platform: string): Promise<ConnectionRefreshClaim> {
  const ref = connectionRef(platform);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`${platform} connection not found`);
    const stored = snap.data() as StoredConnectionDoc;
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
      if (stored.tokenRefresh?.status === "claimed") tx.set(ref, { tokenRefresh: decision.state }, { merge: true });
      return { outcome: "uncertain" };
    }
    if (!connection.refreshToken) throw new Error(`${platform} authorization expired; reconnect it`);
    tx.set(ref, { tokenRefresh: decision.state }, { merge: true });
    return { outcome: "refresh", claimId, connection };
  });
}

export async function completeConnectionTokenRefresh(
  platform: string,
  claimId: string,
  connection: ConnectionDoc,
): Promise<void> {
  const ref = connectionRef(platform);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`${platform} connection not found`);
    const stored = snap.data() as StoredConnectionDoc;
    if (stored.tokenRefresh?.status !== "claimed" || stored.tokenRefresh.claimId !== claimId) {
      throw new Error("connection refresh claim was lost");
    }
    tx.set(ref, encodeConnection(connection));
  });
}

export async function markConnectionTokenRefreshUncertain(
  platform: string,
  claimId: string,
  reason: string,
): Promise<void> {
  const ref = connectionRef(platform);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const stored = snap.data() as StoredConnectionDoc;
    if (stored.tokenRefresh?.status !== "claimed" || stored.tokenRefresh.claimId !== claimId) return;
    tx.set(ref, {
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
  await connectionRef(platform).delete();
}

export async function listConnections(): Promise<ConnectionDoc[]> {
  const snaps = await tenantCollection(CONNECTIONS).get();
  return snaps.docs.map((doc) => {
    return decodeConnection(doc.data() as StoredConnectionDoc);
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
  at?: FirebaseFirestore.FieldValue | string;
}

export async function saveChatMessage(
  m: Omit<ChatMessageDoc, "at" | "userId" | "scopeKey"> & { at?: ChatMessageDoc["at"] },
): Promise<void> {
  const tenant = currentTenant();
  const userId = tenantSubjectId(tenant);
  const scopeKey = chatScopeKey(userId, m.surface, m.conversationId);
  await tenantCollection(CHATS).add({ ...m, userId, scopeKey, at: FieldValue.serverTimestamp() });
  const scoped = await tenantCollection(CHATS).where("scopeKey", "==", scopeKey).get();
  const retained = scoped.docs.map((doc) => {
    const data = doc.data() as ChatMessageDoc & { at?: { toDate(): Date } | string };
    return {
      id: doc.id,
      at: typeof data.at === "string" ? data.at : data.at?.toDate().toISOString() ?? null,
      data: data.data,
    };
  });
  const plan = retentionPlan(retained, CHAT_RETENTION_MAX);
  if (!plan.summary) return;
  const batch = db().batch();
  for (const id of plan.deleteIds) batch.delete(tenantCollection(CHATS).doc(id));
  batch.create(tenantCollection(CHAT_SUMMARIES).doc(newId()), {
    userId,
    surface: m.surface,
    conversationId: m.conversationId,
    scopeKey,
    ...plan.summary,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

export async function listChatMessages(
  limit = 100,
  surface: ChatSurface = "dashboard",
  conversationId = "primary",
): Promise<Array<{ id: string; surface: string; role: string; text: string; data?: Record<string, unknown>; at: string | null }>> {
  const tenant = currentTenant();
  const scopeKey = chatScopeKey(tenantSubjectId(tenant), surface, conversationId);
  const snaps = await tenantCollection(CHATS)
    .where("scopeKey", "==", scopeKey)
    .get();
  return snaps.docs
    .map((d) => {
      const data = d.data() as { surface: string; role: string; text: string; data?: Record<string, unknown>; at?: { toDate(): Date } | string };
      return {
        id: d.id,
        surface: data.surface ?? "dashboard",
        role: data.role,
        text: data.text,
        data: data.data,
        at: typeof data.at === "string" ? data.at : data.at?.toDate().toISOString() ?? null,
      };
    })
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
  const snap = await tenantCollection(CONFIG).doc("operator").get();
  const data = snap.data() as { goals?: OperatorGoals } | undefined;
  return { topics: [], ...data?.goals };
}

export async function saveGoals(goals: OperatorGoals): Promise<void> {
  await tenantCollection(CONFIG).doc("operator").set({ goals }, { merge: true });
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
  target: "effect" | "strategy" | "strategy_feedback";
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
  await db().collection(TELEGRAM_DECISION_NONCES).doc(nonceId).create(value);
}

export interface TelegramStrategyPromptDoc {
  routeTokenDigest: string; workspaceId: string; brandId: string; jobId: string;
  payloadDigest: string; actorSubjectId: string; expiresAt: string; state: "pending" | "processing" | "consumed";
  claimedAt?: string; decisionId?: string;
}

export async function saveTelegramStrategyPrompt(routeTokenDigest: string, messageId: number, value: TelegramStrategyPromptDoc): Promise<void> {
  await db().collection(TELEGRAM_STRATEGY_PROMPTS).doc(telegramDigest(`${routeTokenDigest}:${messageId}`)).create(value);
}

export async function claimTelegramStrategyPrompt(routeToken: string, messageId: number): Promise<{ duplicate: boolean; prompt: TelegramStrategyPromptDoc }> {
  const routeTokenDigest = telegramDigest(routeToken);
  const ref = db().collection(TELEGRAM_STRATEGY_PROMPTS).doc(telegramDigest(`${routeTokenDigest}:${messageId}`));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Telegram strategy feedback prompt not found");
    const value = snap.data() as TelegramStrategyPromptDoc;
    if (value.routeTokenDigest !== routeTokenDigest) throw new Error("Telegram strategy prompt route mismatch");
    const decision = decideTelegramNonceClaim(value);
    if (decision.outcome === "duplicate") return { duplicate: true, prompt: value };
    const prompt = { ...value, state: "processing" as const, claimedAt: new Date().toISOString() };
    tx.update(ref, prompt);
    return { duplicate: false, prompt };
  });
}

export async function finalizeTelegramStrategyPrompt(routeToken: string, messageId: number, decisionId: string): Promise<void> {
  const routeTokenDigest = telegramDigest(routeToken);
  await db().collection(TELEGRAM_STRATEGY_PROMPTS).doc(telegramDigest(`${routeTokenDigest}:${messageId}`)).update({ state: "consumed", decisionId });
}

export async function getTelegramWebhookRoute(routeToken: string): Promise<TelegramWebhookRoute | null> {
  const routeTokenDigest = telegramDigest(routeToken);
  const snap = await db().collection(TELEGRAM_WEBHOOK_ROUTES).doc(routeTokenDigest).get();
  return snap.exists ? (snap.data() as TelegramWebhookRoute) : null;
}

export async function claimTelegramDecisionNonce(
  routeToken: string,
  nonce: string,
): Promise<{ duplicate: boolean; nonce: TelegramDecisionNonceDoc }> {
  const routeTokenDigest = telegramDigest(routeToken);
  const nonceId = telegramDigest(`${routeTokenDigest}:${nonce}`);
  const ref = db().collection(TELEGRAM_DECISION_NONCES).doc(nonceId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Telegram decision nonce not found");
    const value = snap.data() as TelegramDecisionNonceDoc;
    if (value.routeTokenDigest !== routeTokenDigest) throw new Error("Telegram decision nonce route mismatch");
    const decision = decideTelegramNonceClaim(value);
    if (decision.outcome === "duplicate") return { duplicate: true, nonce: value };
    const claimed = { ...value, state: "processing" as const, claimedAt: new Date().toISOString() };
    tx.update(ref, claimed);
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
  await db().collection(TELEGRAM_DECISION_NONCES).doc(nonceId).update({
    state: "consumed",
    decisionId,
  });
}

export async function getTelegramConnection(): Promise<TelegramConnectionDoc | null> {
  const snap = await tenantCollection(CONFIG).doc("telegram").get();
  if (!snap.exists) return null;
  const stored = snap.data() as StoredTelegramConnectionDoc;
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
  const configRef = tenantCollection(CONFIG).doc("telegram");
  const routeRef = db().collection(TELEGRAM_WEBHOOK_ROUTES).doc(connection.routeTokenDigest);
  const { botToken, ...metadata } = connection;
  const stored: StoredTelegramConnectionDoc = {
    ...metadata,
    botTokenEnvelope: encryptSecret(botToken, connectionEnvelopeKey(), `${tenant.workspaceId}:telegram:bot`),
  };
  await db().runTransaction(async (tx) => {
    const existing = await tx.get(configRef);
    const existingRoute = existing.get("routeTokenDigest") as string | undefined;
    if (existingRoute && existingRoute !== connection.routeTokenDigest) {
      tx.delete(db().collection(TELEGRAM_WEBHOOK_ROUTES).doc(existingRoute));
    }
    tx.set(configRef, stored);
    tx.set(routeRef, {
      routeTokenDigest: connection.routeTokenDigest,
      webhookSecretDigest: connection.webhookSecretDigest,
      chatIdDigest: connection.chatIdDigest,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
    } satisfies TelegramWebhookRoute);
  });
}

export async function deleteTelegramConnection(): Promise<void> {
  const configRef = tenantCollection(CONFIG).doc("telegram");
  await db().runTransaction(async (tx) => {
    const existing = await tx.get(configRef);
    const routeTokenDigest = existing.get("routeTokenDigest") as string | undefined;
    if (routeTokenDigest) tx.delete(db().collection(TELEGRAM_WEBHOOK_ROUTES).doc(routeTokenDigest));
    tx.delete(configRef);
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
  return tenantCollection(ASSETS).doc(`${jobId}_${actionId}`);
}

export async function saveAsset(asset: AssetDoc): Promise<void> {
  await assetRef(asset.jobId, asset.actionId).set(asset);
}

export async function getAsset(jobId: string, actionId: string): Promise<AssetDoc | null> {
  const snap = await assetRef(jobId, actionId).get();
  if (!snap.exists) return null;
  return snap.data() as AssetDoc;
}

export async function listAssets(jobId: string): Promise<AssetDoc[]> {
  const snaps = await tenantCollection(ASSETS)
    .where("jobId", "==", jobId)
    .get();
  return snaps.docs.map((d) => d.data() as AssetDoc);
}

export async function listAllAssets(): Promise<AssetDoc[]> {
  const snaps = await tenantCollection(ASSETS).orderBy("createdAt", "desc").limit(100).get();
  return snaps.docs.map((d) => d.data() as AssetDoc);
}

export interface ReceiptWithJob extends Receipt {
  jobTitle?: string;
}

export async function listRecentReceipts(limit = 200): Promise<ReceiptWithJob[]> {
  const snaps = await tenantCollection(JOBS)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  const out: ReceiptWithJob[] = [];
  for (const doc of snaps.docs) {
    const data = doc.data() as JobDoc;
    const rs = await doc.ref.collection(RECEIPTS).get();
    for (const r of rs.docs) {
      const receipt = r.data() as Receipt;
      out.push({
        ...receipt,
        jobTitle: data.ingestedTitle ?? `Source bundle ${data.config.sourceManifestId.slice(0, 8)}`,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt)).slice(0, limit);
}

function jobRef(jobId: string) {
  return tenantCollection(JOBS).doc(jobId);
}

function requireJobDoc(snap: FirebaseFirestore.DocumentSnapshot): Job & {
  transcriptSegments: Array<{ id: string; startSec: number; endSec: number; text: string }>;
  transcriptLanguage?: string;
  drafts: PostDraft[];
  contentPack?: { markdown: string; digest: string; generatedAt: string };
  actions: PlannedAction[];
  verifications: VerificationResult[];
  packet?: EvidencePacket;
} {
  if (!snap.exists) throw new Error(`job not found: ${snap.id}`);
  const data = snap.data() as JobDoc;
  assertResourceWorkspace(currentTenant(), data);
  return {
    id: snap.id,
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
    failure: data.failure,
    ingestedTitle: data.ingestedTitle,
    ingestedChannel: data.ingestedChannel,
    ingestedDurationSec: data.ingestedDurationSec,
    mediaDigest: data.mediaDigest,
    contentStrategy: data.contentStrategy,
    strategyDigest: data.strategyDigest,
    strategyRevision: data.strategyRevision,
    strategyApprovalState: data.strategyApprovalState,
    strategyApproval: data.strategyApproval,
    strategyApprovalExpiresAt: data.strategyApprovalExpiresAt,
    strategyRevisionFeedback: data.strategyRevisionFeedback,
    strategyEvidenceLineage: data.strategyEvidenceLineage,
    strategyHistory: data.strategyHistory,
    strategyInvocationContext: data.strategyInvocationContext,
    editorialPlan: data.editorialPlan,
    editorialPlanDigest: data.editorialPlanDigest,
    editorialPlanRevision: data.editorialPlanRevision,
    editorialPlanEvidenceLineage: data.editorialPlanEvidenceLineage,
    selectedNextItemId: data.selectedNextItemId,
    editorialItemStates: data.editorialItemStates,
    activeProductionLineage: data.activeProductionLineage,
    editorialPlanHistory: data.editorialPlanHistory,
    editorialPlanningSnapshot: data.editorialPlanningSnapshot,
    editorialPlanningSnapshotDigest: data.editorialPlanningSnapshotDigest,
    editorialPlanningSnapshotHistory: data.editorialPlanningSnapshotHistory,
    videoId: data.videoId,
    transcriptSegments: data.transcriptSegments ?? [],
    transcriptLanguage: data.transcriptLanguage,
    sourceAnalysis: data.sourceAnalysis,
    analysisDigest: data.analysisDigest,
    analysisResearchRequest: data.analysisResearchRequest,
    analysisSearchEvidence: data.analysisSearchEvidence,
    analysisGroundingMetadata: data.analysisGroundingMetadata,
    drafts: data.drafts ?? [],
    contentPack: data.contentPack,
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
  const contentItems = await tenantCollection(CONTENT_ITEMS).where("jobId", "==", plan.jobId).get();
  const liveItem = contentItems.docs.find((doc) =>
    ["scheduled", "awaiting_final_review", "publishing"].includes(String(doc.get("status"))),
  );
  if (liveItem) throw new Error("job has a content item with pending external work");

  const tombstoneRef = tenantCollection(DELETION_TOMBSTONES).doc(plan.jobId);
  await tombstoneRef.set({
    ...deletionTombstone(plan, actorSubjectId),
    state: "erasing",
  });

  const assets = await listAssets(plan.jobId);
  for (const asset of assets) await deleteArtifactUri(asset.storageUri);

  const manifestSnapshot = await jobRef(plan.jobId).collection("source_manifests").doc(job.config.sourceManifestId).get();
  const directSourceIds = (manifestSnapshot.get("directSourceIds") as string[] | undefined) ?? [];
  for (const sourceId of directSourceIds) {
    const payloadRef = db().doc(`workspaces/${job.workspaceId}/brands/${job.brandId}/source_payloads/${sourceId}`);
    const payload = await payloadRef.get();
    const attachmentId = payload.get("input.attachmentId") as string | undefined;
    if (attachmentId) {
      const attachmentRef = tenantCollection("chat_attachments").doc(attachmentId);
      const attachment = await attachmentRef.get();
      const uri = String(attachment.get("storageUri") ?? "");
      if (uri) await deleteArtifactUri(uri);
      if (attachment.exists) await attachmentRef.delete();
    }
    await payloadRef.delete();
  }

  const denormalized = await Promise.all([
    tenantCollection(ASSETS).where("jobId", "==", plan.jobId).get(),
    tenantCollection(EVENT_LOG).where("jobId", "==", plan.jobId).get(),
    tenantCollection(PROPOSALS).where("jobId", "==", plan.jobId).get(),
    tenantCollection(NOTIFICATIONS).where("refId", "==", plan.jobId).get(),
  ]);
  await Promise.all(denormalized.flatMap((snapshot) => snapshot.docs.map((doc) => doc.ref.delete())));
  await Promise.all(contentItems.docs.map((doc) => doc.ref.delete()));
  await db().recursiveDelete(jobRef(plan.jobId));
  await tombstoneRef.set({ state: "erased", completedAt: new Date().toISOString() }, { merge: true });
}

export async function eraseDueJobs(now = new Date(), limit = 20): Promise<string[]> {
  const snapshots = await tenantCollection(JOBS)
    .where("retentionDeleteAfter", "<=", now.toISOString())
    .limit(Math.max(1, Math.min(limit, 100)))
    .get();
  const erased: string[] = [];
  for (const snapshot of snapshots.docs) {
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
    tenantCollection(JOBS).get(),
    tenantCollection(CONTENT_ITEMS).get(),
    tenantCollection(ASSETS).get(),
    tenantCollection("chat_attachments").get(),
    tenantCollection(CONFIG).doc("telegram").get(),
    tenantCollection(CONNECTIONS).get(),
    db().collection("oauth_states").where("workspaceId", "==", plan.workspaceId).get(),
    db().collection("users").doc(actorSubjectId).get(),
  ]);
  if (jobs.docs.some((doc) => {
    const value = doc.data() as JobDoc;
    return value.retentionHold || !["complete", "failed"].includes(value.status);
  })) {
    throw new Error("workspace contains active jobs or retention holds");
  }
  if (contentItems.docs.some((doc) =>
    ["scheduled", "awaiting_final_review", "publishing"].includes(String(doc.get("status"))),
  )) {
    throw new Error("workspace contains pending external work");
  }
  if (!connections.empty) {
    throw new Error("disconnect external connections before workspace deletion");
  }

  const tombstoneRef = db().collection("workspace_deletion_tombstones").doc(plan.workspaceId);
  await tombstoneRef.set({
    workspaceId: plan.workspaceId,
    reason: plan.reason,
    requestedAt: plan.requestedAt,
    deletedBySubjectId: actorSubjectId,
    state: "erasing",
  });
  for (const doc of [...assets.docs, ...attachments.docs]) {
    const uri = String(doc.get("storageUri") ?? "");
    if (uri) await deleteWorkspaceArtifactUri(uri, plan.workspaceId);
  }
  const routeTokenDigest = telegram.get("routeTokenDigest") as string | undefined;
  if (routeTokenDigest) {
    await db().collection(TELEGRAM_WEBHOOK_ROUTES).doc(routeTokenDigest).delete();
  }
  await Promise.all(oauthStates.docs.map((state) => state.ref.delete()));
  await db().recursiveDelete(db().collection("workspaces").doc(plan.workspaceId));
  if (user.exists && user.get("defaultWorkspaceId") === plan.workspaceId) {
    await user.ref.delete();
  }
  await tombstoneRef.set({
    state: "erased",
    completedAt: new Date().toISOString(),
    contentErased: true,
    oauthStatesErased: true,
    identityPointerErased: !user.exists || user.get("defaultWorkspaceId") === plan.workspaceId,
  }, { merge: true });
}

export async function createJob(
  config: JobConfig,
  initialStage: Stage,
  setup?: (transaction: FirebaseFirestore.Transaction, jobId: string, now: string) => void,
): Promise<Job> {
  const id = newId();
  const now = new Date().toISOString();
  const storedConfig: JobConfig = { ...config };
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
    budget: initialJobBudget(),
  };
  const outboxId = stageOutboxId(id, initialStage, 0);
  await db().runTransaction(async (tx) => {
    tx.create(jobRef(id), doc);
    setup?.(tx, id, now);
    tx.create(stageOutboxRef(outboxId), {
      id: outboxId,
      workspaceId: tenant.workspaceId,
      brandId: tenant.brandId,
      jobId: id,
      stage: initialStage,
      attempt: 0,
      ...stageOutboxDurability(outboxId, id, initialStage),
      state: "pending",
      createdAt: now,
    } satisfies StageOutboxRecord);
  });
  return { id, ...doc };
}

export async function retryFailedJobWithOutbox(jobId: string, stage: Stage, attempt: number): Promise<string> {
  const id = stageOutboxId(jobId, stage, attempt);
  const ref = stageOutboxRef(id);
  const tenant = currentTenant();
  await db().runTransaction(async (tx) => {
    const [jobSnapshot, existing] = await Promise.all([tx.get(jobRef(jobId)), tx.get(ref)]);
    const job = requireJobDoc(jobSnapshot);
    if (job.status !== "failed" || job.failure?.stage !== stage) throw new Error("job is not retryable from this stage");
    tx.update(jobRef(jobId), { stage, status: "running", updatedAt: new Date().toISOString() });
    if (!existing.exists) tx.create(ref, {
      id, workspaceId: tenant.workspaceId, brandId: tenant.brandId, jobId, stage, attempt,
      ...stageOutboxDurability(id, jobId, stage),
      state: "pending", createdAt: new Date().toISOString(),
    } satisfies StageOutboxRecord);
  });
  return id;
}

export async function getJob(jobId: string) {
  const snap = await jobRef(jobId).get();
  return requireJobDoc(snap);
}

export async function listJobs(limit = 25): Promise<Job[]> {
  const snaps = await tenantCollection(JOBS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => requireJobDoc(d));
}

export async function setStage(
  jobId: string,
  stage: Stage,
  status: Job["status"] = "running",
): Promise<void> {
  await jobRef(jobId).update({
    stage,
    status,
    updatedAt: new Date().toISOString(),
  });
}

function stageClaimDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function claimJobStageExecution(input: {
  jobId: string;
  stage: string;
  ownerId: string;
  claimToken: string;
}): Promise<StageClaimResult> {
  const ref = jobRef(input.jobId);
  const executionRef = ref.collection(STAGE_EXECUTIONS).doc(input.stage);
  return db().runTransaction(async (tx) => {
    const [jobSnap, executionSnap] = await Promise.all([tx.get(ref), tx.get(executionRef)]);
    const job = requireJobDoc(jobSnap);
    const existing = executionSnap.exists ? executionSnap.data() as StageExecution : null;
    if (!existing && job.stage !== input.stage) throw new Error(`job stage is '${job.stage}', not '${input.stage}'`);
    const now = new Date();
    const result = decideStageClaim(existing, {
      jobId: input.jobId,
      stage: input.stage,
      ownerId: input.ownerId,
      claimTokenDigest: stageClaimDigest(input.claimToken),
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    });
    if (!existing) tx.create(executionRef, result.execution);
    else if (result.execution !== existing) tx.set(executionRef, result.execution);
    return result;
  });
}

export async function finalizeJobStageExecution(input: {
  jobId: string;
  stage: string;
  claimToken: string;
  outcome: "applied" | "failed" | "uncertain";
  failureReason?: string;
}): Promise<StageExecution> {
  const ref = jobRef(input.jobId).collection(STAGE_EXECUTIONS).doc(input.stage);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("stage execution claim not found");
    const current = snap.data() as StageExecution;
    const finalized = finalizeStageExecution(
      current,
      stageClaimDigest(input.claimToken),
      input.outcome,
      new Date().toISOString(),
      input.failureReason,
    );
    tx.set(ref, finalized);
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
): Promise<{ reserved: boolean; duplicate: boolean; budget: JobBudget }> {
  const ref = jobRef(input.jobId);
  const reservationRef = ref.collection(COST_RESERVATIONS).doc(input.operationId);
  const workspaceRef = db().collection("workspaces").doc(currentTenant().workspaceId);
  return db().runTransaction(async (tx) => {
    const [jobSnap, reservationSnap, workspaceSnap] = await Promise.all([
      tx.get(ref), tx.get(reservationRef), tx.get(workspaceRef),
    ]);
    const job = requireJobDoc(jobSnap);
    const budget = job.budget ?? initialJobBudget();
    if (reservationSnap.exists) {
      const existing = reservationSnap.data() as BudgetReservation;
      return { reserved: existing.accepted, duplicate: true, budget };
    }

    if (!workspaceSnap.exists) throw new Error("workspace not found");
    const workspaceBudget = (workspaceSnap.get("budget") as JobBudget | undefined) ?? {
      estimatedUsd: "0.00",
      observedUsd: "0.00",
      reservedUsd: "0.00",
      limitUsd: parseBudgetConfig(process.env).DEFAULT_WORKSPACE_BUDGET_USD,
      approvalThresholdUsd: budget.approvalThresholdUsd,
    };
    const accepted = !exceedsApprovalThreshold(budget, input.estimatedCostUsd)
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
    tx.set(reservationRef, reservation);
    if (!accepted) return { reserved: false, duplicate: false, budget };

    const updated = applyReservation(budget, input.estimatedCostUsd);
    tx.update(ref, { budget: updated, updatedAt: new Date().toISOString() });
    tx.update(workspaceRef, {
      budget: applyReservation(workspaceBudget, input.estimatedCostUsd),
      updatedAt: new Date().toISOString(),
    });
    return { reserved: true, duplicate: false, budget: updated };
  });
}

export async function finalizeUsageRecord(record: UsageRecord): Promise<{ duplicate: boolean }> {
  const ref = jobRef(record.jobId);
  const reservationRef = ref.collection(COST_RESERVATIONS).doc(record.operationId);
  const usageRef = ref.collection(USAGE_RECORDS).doc(record.id);
  const workspaceRef = db().collection("workspaces").doc(currentTenant().workspaceId);
  return db().runTransaction(async (tx) => {
    const [jobSnap, reservationSnap, usageSnap, workspaceSnap] = await Promise.all([
      tx.get(ref),
      tx.get(reservationRef),
      tx.get(usageRef),
      tx.get(workspaceRef),
    ]);
    if (usageSnap.exists) return { duplicate: true };
    const job = requireJobDoc(jobSnap);
    if (!reservationSnap.exists) throw new Error(`missing cost reservation: ${record.operationId}`);
    const reservation = reservationSnap.data() as BudgetReservation;
    if (!reservation.accepted) throw new Error(`cost reservation was rejected: ${record.operationId}`);
    if (reservation.state !== "reserved") throw new Error(`cost reservation is ${reservation.state}: ${record.operationId}`);

    const budget = applyFinalizedUsage(
      job.budget ?? initialJobBudget(),
      reservation.estimatedCostUsd,
      record.observedCostUsd ?? record.estimatedCostUsd,
    );
    if (!workspaceSnap.exists) throw new Error("workspace not found");
    const workspaceBudget = workspaceSnap.get("budget") as JobBudget;
    const finalizedWorkspaceBudget = applyFinalizedUsage(
      workspaceBudget,
      reservation.estimatedCostUsd,
      record.observedCostUsd ?? record.estimatedCostUsd,
    );
    tx.set(usageRef, record);
    tx.update(reservationRef, markReservationFinalized(reservation, new Date().toISOString()));
    tx.update(ref, { budget, updatedAt: new Date().toISOString() });
    tx.update(workspaceRef, {
      budget: finalizedWorkspaceBudget,
      updatedAt: new Date().toISOString(),
    });
    return { duplicate: false };
  });
}

export async function resolveJobBudgetReservation(input: {
  jobId: string;
  operationId: string;
  outcome: "not_invoked" | "uncertain";
  reason: string;
}): Promise<{ duplicate: boolean; state: CostReservationState["state"] }> {
  const ref = jobRef(input.jobId);
  const reservationRef = ref.collection(COST_RESERVATIONS).doc(input.operationId);
  const workspaceRef = db().collection("workspaces").doc(currentTenant().workspaceId);
  return db().runTransaction(async (tx) => {
    const [jobSnap, reservationSnap, workspaceSnap] = await Promise.all([
      tx.get(ref), tx.get(reservationRef), tx.get(workspaceRef),
    ]);
    const job = requireJobDoc(jobSnap);
    if (!reservationSnap.exists) throw new Error(`missing cost reservation: ${input.operationId}`);
    const reservation = reservationSnap.data() as BudgetReservation;
    if (!reservation.accepted) throw new Error(`cost reservation was rejected: ${input.operationId}`);
    if (reservation.state !== "reserved") return { duplicate: true, state: reservation.state };

    const now = new Date().toISOString();
    if (input.outcome === "uncertain") {
      const uncertain = markReservationUncertain(reservation, input.reason, now);
      tx.update(reservationRef, uncertain);
      return { duplicate: false, state: "uncertain" };
    }

    if (!workspaceSnap.exists) throw new Error("workspace not found");
    const workspaceBudget = workspaceSnap.get("budget") as JobBudget;
    const budget = applyReleasedReservation(job.budget ?? initialJobBudget(), reservation.estimatedCostUsd);
    const releasedWorkspaceBudget = applyReleasedReservation(workspaceBudget, reservation.estimatedCostUsd);
    tx.update(reservationRef, { ...markReservationReleased(reservation, now), releaseReason: input.reason });
    tx.update(ref, { budget, updatedAt: now });
    tx.update(workspaceRef, { budget: releasedWorkspaceBudget, updatedAt: now });
    return { duplicate: false, state: "released" };
  });
}

export async function listUsageRecords(jobId: string): Promise<UsageRecord[]> {
  const snaps = await jobRef(jobId)
    .collection(USAGE_RECORDS)
    .orderBy("createdAt", "asc")
    .get();
  return snaps.docs.map((doc) => doc.data() as UsageRecord);
}

export interface MediaOperationRecord {
  jobId: string;
  actionId: string;
  provider: "veo" | "lyria";
  operationName: string;
  createdAt: string;
}

export async function saveMediaOperation(
  jobId: string,
  actionId: string,
  provider: "veo" | "lyria",
  operationName: string,
): Promise<MediaOperationRecord> {
  const ref = jobRef(jobId).collection(MEDIA_OPERATIONS).doc(actionId);
  return db().runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      const record = existing.data() as MediaOperationRecord;
      if (record.provider !== provider || record.operationName !== operationName) {
        throw new Error(`media operation already recorded for action ${actionId}`);
      }
      return record;
    }
    const job = requireJobDoc(await tx.get(jobRef(jobId)));
    const action = (job.actions ?? []).find((item) => item.id === actionId);
    if (!action) throw new Error(`action ${actionId} not found on job ${jobId}`);
    const record: MediaOperationRecord = {
      jobId, actionId, provider, operationName, createdAt: new Date().toISOString(),
    };
    tx.set(ref, record);
    return record;
  });
}

export async function getMediaOperation(
  jobId: string,
  actionId: string,
): Promise<MediaOperationRecord | null> {
  const snap = await jobRef(jobId).collection(MEDIA_OPERATIONS).doc(actionId).get();
  return snap.exists ? (snap.data() as MediaOperationRecord) : null;
}

export async function saveIngestMeta(
  jobId: string,
  meta: {
    videoId: string;
    title: string;
    channel: string;
    durationSec: number;
    mediaDigest?: string;
  },
) {
  const digest = meta.mediaDigest ? { mediaDigest: meta.mediaDigest } : {};
  await jobRef(jobId).update({
    videoId: meta.videoId,
    ingestedTitle: meta.title,
    ingestedChannel: meta.channel,
    ingestedDurationSec: meta.durationSec,
    ...digest,
    updatedAt: new Date().toISOString(),
  });
}

export async function saveTranscript(
  jobId: string,
  segments: Array<{ id: string; startSec: number; endSec: number; text: string }>,
  language: string,
) {
  await jobRef(jobId).update({
    transcriptSegments: segments,
    transcriptLanguage: language,
    updatedAt: new Date().toISOString(),
  });
}

export async function saveAnalysis(
  jobId: string,
  sourceAnalysis: import("./types").SourceAnalysis,
  analysisDigest: string,
  analysisResearchRequest: import("./types").AnalysisResearchRequest | null,
  analysisSearchEvidence: import("./types").AnalysisSearchEvidence[],
  analysisGroundingMetadata: Record<string, unknown> | null,
) {
  await jobRef(jobId).update({
    sourceAnalysis,
    analysisDigest,
    analysisResearchRequest,
    analysisSearchEvidence,
    analysisGroundingMetadata,
    updatedAt: new Date().toISOString(),
  });
}

export async function acceptStrategyProposal(
  jobId: string, strategy: import("./types").ContentStrategy, digest: string, revision: number,
  searchEvidence: import("./types").StrategySearchEvidence[], groundingMetadata: Record<string, unknown> | null,
) {
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
    const job = requireJobDoc(snap);
    assertStrategyProposalRevision(job.stage, job.strategyRevision, revision, strategy.version);
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
    const historyKey = `strategyHistory.v${revision}`;
    tx.update(ref, {
      contentStrategy: strategy, strategyDigest: digest, strategyRevision: revision,
      strategyApprovalState: "pending", strategyApproval: FieldValue.delete(),
      strategyApprovalExpiresAt: expiresAt, strategyEvidenceLineage: evidenceLineage,
      strategyInvocationContext: invocationContext,
      [historyKey]: { strategy, digest, revision, evidenceLineage, invocationContext, proposedAt: new Date().toISOString(), expiresAt },
      stage: "awaiting_strategy_approval", status: "waiting_for_approval", updatedAt: new Date().toISOString(),
    });
    return { digest, expiresAt, evidenceLineage };
  });
}

export async function saveStrategyInvocationContext(jobId: string, context: import("./types").StrategyInvocationContext) {
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
    const job = requireJobDoc(snap);
    assertStrategyProposalRevision(job.stage, job.strategyRevision, context.revision, context.revision);
    const configured = job.config.strategyContext;
    if (!configured) throw new Error("typed strategy context required");
    if (JSON.stringify([...context.operatorContextIds].sort()) !== JSON.stringify(["context:campaign", "context:company"])) throw new Error("strategy operator context IDs mismatch");
    if (!job.sourceAnalysis || !job.analysisDigest) throw new Error("persisted source analysis required");
    const sourceIds = [...new Set([...job.sourceAnalysis.moments, ...job.sourceAnalysis.angles].map((item) => item.id))].sort();
    if (JSON.stringify([...context.sourceIds].sort()) !== JSON.stringify(sourceIds)) throw new Error("strategy source context mismatch");
    if (JSON.stringify([...context.audienceIds].sort()) !== JSON.stringify(configured.audiences.map((item) => item.id).sort())) throw new Error("strategy audience context mismatch");
    if (JSON.stringify([...context.requestedChannels].sort()) !== JSON.stringify([...configured.requestedChannels].sort())) throw new Error("strategy requested channels mismatch");
    if (JSON.stringify([...context.supportedChannels].sort()) !== JSON.stringify([...configured.supportedChannels].sort())) throw new Error("strategy supported channels mismatch");
    if (context.horizonWeeks !== (configured.horizonWeeks ?? 4)) throw new Error("strategy horizon mismatch");
    if (JSON.stringify(context.researchRequest) !== JSON.stringify(configured.researchRequest ?? null)) throw new Error("strategy research request mismatch");
    if (context.searchEvidence.length) throw new Error("strategy search evidence cannot exist before Ryan runs");
    tx.update(ref, { strategyInvocationContext: context, updatedAt: new Date().toISOString() });
  });
}

export async function acceptEditorialPlan(
  jobId: string,
  plan: import("./types").EditorialPlan,
  revision: number,
) {
  const tenant = currentTenant();
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const outboxId = stageOutboxId(jobId, "draft", 0);
    const outboxRef = stageOutboxRef(outboxId);
    const [snap, existingOutbox] = await Promise.all([tx.get(ref), tx.get(outboxRef)]);
    const job = requireJobDoc(snap);
    assertEditorialPlanSubmission(job, plan, revision);
    if (existingOutbox.exists) throw new Error("editorial plan draft dispatch already exists");
    const digest = editorialPlanDigest(plan);
    const evidenceLineage = editorialPlanEvidenceLineage(plan);
    const acceptedAt = new Date().toISOString();
    const itemStates = Object.fromEntries(plan.items.map((item) => [item.id, {
      status: item.id === plan.selectedNextItemId ? "selected" : "planned", updatedAt: acceptedAt,
    }]));
    tx.update(ref, {
      editorialPlan: plan, editorialPlanDigest: digest, editorialPlanRevision: revision,
      editorialPlanEvidenceLineage: evidenceLineage, selectedNextItemId: plan.selectedNextItemId,
      editorialItemStates: itemStates,
      [`editorialPlanHistory.v${revision}`]: {
        plan, digest, revision, strategyId: job.contentStrategy!.strategyId,
        strategyDigest: job.strategyDigest!, evidenceLineage,
        selectedNextItemId: plan.selectedNextItemId, acceptedAt,
      },
      stage: "draft", status: "running", updatedAt: acceptedAt,
    });
    tx.create(outboxRef, {
      id: outboxId, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
      jobId, stage: "draft", attempt: 0, completedStage: "plan",
      note: `editorial plan ${digest} accepted; selected ${plan.selectedNextItemId}`,
      ...stageOutboxDurability(outboxId, jobId, "draft", "plan"),
      state: "pending", createdAt: acceptedAt,
    } satisfies StageOutboxRecord);
    return { digest, evidenceLineage, selectedNextItemId: plan.selectedNextItemId, outboxId };
  });
}

export async function claimSelectedEditorialItem(
  jobId: string,
  authority: { editorialPlanId: string; editorialPlanDigest: string; editorialItemId: string; briefId: string },
) {
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
    const job = requireJobDoc(snap);
    assertSelectedProductionAuthority(job, authority, "selected");
    const updatedAt = new Date().toISOString();
    tx.update(ref, {
      [`editorialItemStates.${authority.editorialItemId}`]: { status: "drafting", updatedAt },
      activeProductionLineage: authority,
      updatedAt,
    });
    return { outcome: "execute" as const, ...authority };
  });
}

export async function finalizeEditorialItemDraft(
  jobId: string,
  lineage: { editorialPlanId: string; editorialPlanDigest: string; editorialItemId: string; briefId: string },
  productionTrace: DraftWorkflowResult,
  actions: PlannedAction[],
  needsApproval: boolean,
) {
  const traceDigest = createHash("sha256").update(canonicalJson(productionTrace), "utf8").digest("hex");
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
    const job = requireJobDoc(snap);
    const active = job.activeProductionLineage;
    if (isMatchingCompletedProduction(job, lineage, needsApproval)) {
      if (job.productionTraceDigest !== traceDigest) throw new Error("completed production trace digest mismatch");
      return { outcome: "already_applied" as const, productionTrace: job.productionTrace, actions: job.actions };
    }
    assertSelectedProductionAuthority(job, lineage, "drafting");
    if (!active || active.editorialPlanId !== lineage.editorialPlanId || active.editorialPlanDigest !== lineage.editorialPlanDigest || active.editorialItemId !== lineage.editorialItemId || active.briefId !== lineage.briefId) throw new Error("production lineage mismatch");
    const linkedActions = actions.map((action) => ({ ...action, ...lineage }));
    const updatedAt = new Date().toISOString();
    tx.update(ref, {
      productionTrace, productionTraceDigest: traceDigest, actions: linkedActions,
      ...editorialDraftCompletionPatch(lineage.editorialItemId, updatedAt, needsApproval),
    });
    for (const action of linkedActions) {
      if (action.type !== "publish_x_post") continue;
      const text = String((action.payload as { text?: unknown }).text ?? "");
      if (!text) continue;
      tx.set(contentItemRef(`item-${action.id}`), {
        id: `item-${action.id}`, jobId, ...lineage,
        draftId: productionTrace.acceptedDraft.id,
        draftRevision: productionTrace.acceptedDraft.revision,
        text, platforms: ["x"],
        status: "draft", publishMode: "approval", createdAt: updatedAt, updatedAt,
      } satisfies import("./types").ContentItem);
    }
    return { outcome: "execute" as const, productionTrace, actions: linkedActions };
  });
}

export async function decideStrategy(jobId: string, input: StrategyDecisionInput) {
  const tenant = currentTenant();
  const actorSubjectId = tenantSubjectId(tenant);
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
    const job = requireJobDoc(snap);
    if (job.stage !== "awaiting_strategy_approval") throw new Error("strategy is not awaiting approval");
    if (!job.strategyDigest || !job.strategyRevision) throw new Error("strategy proposal is incomplete");
    const result = applyStrategyDecision(
      { revision: job.strategyRevision, strategyDigest: job.strategyDigest,
        approvalExpiresAt: job.strategyApprovalExpiresAt ?? "1970-01-01T00:00:00.000Z" }, input,
      actorSubjectId, new Date(),
    );
    const update: Record<string, unknown> = {
      strategyApproval: result.approval,
      strategyApprovalState: result.approval.decision,
      stage: result.nextStage,
      status: result.nextStage === "complete" ? "complete" : "running",
      updatedAt: new Date().toISOString(),
      [`strategyHistory.v${job.strategyRevision}.approval`]: result.approval,
    };
    if (result.nextStage === "strategize") {
      update.strategyRevision = result.nextRevision;
      update.strategyRevisionFeedback = result.approval.feedback;
    }
    if (result.nextStage === "complete") update.terminalOutcome = "rejected";
    tx.update(ref, update);
    let outboxId: string | undefined;
    if (result.nextStage === "plan" || result.nextStage === "strategize") {
      const attempt = result.nextStage === "strategize" ? 1 : 0;
      outboxId = stageOutboxId(jobId, result.nextStage, attempt);
      tx.create(stageOutboxRef(outboxId), {
        id: outboxId, workspaceId: tenant.workspaceId, brandId: tenant.brandId,
        jobId, stage: result.nextStage, attempt, completedStage: "awaiting_strategy_approval",
        note: result.nextStage === "plan" ? "strategy approved; editorial planning dispatched" : "strategy revision requested",
        ...stageOutboxDurability(outboxId, jobId, result.nextStage, "awaiting_strategy_approval"),
        state: "pending", createdAt: new Date().toISOString(),
      } satisfies StageOutboxRecord);
    }
    return { ...result, outboxId };
  });
}

export async function saveDrafts(jobId: string, drafts: PostDraft[]) {
  await jobRef(jobId).update({
    drafts,
    updatedAt: new Date().toISOString(),
  });
}

export async function saveContentPack(
  jobId: string,
  markdown: string,
  digest: string,
) {
  const observedDigest = createHash("sha256").update(markdown).digest("hex");
  if (observedDigest !== digest) throw new Error("content pack digest mismatch");
  await jobRef(jobId).update({
    contentPack: { markdown, digest, generatedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  });
}

export async function saveActions(jobId: string, actions: PlannedAction[]) {
  await jobRef(jobId).update({
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
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
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
    const decisionRef = ref.collection(APPROVAL_DECISIONS).doc(actionId);
    tx.create(decisionRef, {
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
    tx.update(ref, {
      actions: job.actions,
      updatedAt: decidedAt,
    });
    return action;
  });
}

export async function listApprovalDecisions(jobId: string): Promise<Array<Omit<ApprovalDecision, "authenticationId">>> {
  const snaps = await jobRef(jobId).collection(APPROVAL_DECISIONS).orderBy("decidedAt", "asc").get();
  return snaps.docs.map((doc) => {
    const decision = { ...(doc.data() as ApprovalDecision) } as Partial<ApprovalDecision>;
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
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const job = requireJobDoc(snap);
    const action = job.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    action.state = state;
    tx.update(ref, {
      actions: job.actions,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function writeReceipt(receipt: Receipt): Promise<void> {
  await tenantCollection(JOBS)
    .doc(receipt.jobId)
    .collection(RECEIPTS)
    .doc(receipt.id)
    .set(receipt);
}

export async function finalizeEffectReceipt(
  receipt: Receipt,
  claimToken: string,
): Promise<{ duplicate: boolean; receipt: Receipt }> {
  const ref = jobRef(receipt.jobId);
  const claimRef = ref.collection(EFFECT_CLAIMS).doc(receipt.idempotencyKey);
  return db().runTransaction(async (tx) => {
    const [jobSnap, claimSnap] = await Promise.all([tx.get(ref), tx.get(claimRef)]);
    const job = requireJobDoc(jobSnap);
    if (!claimSnap.exists) throw new Error("effect receipt has no durable claim");
    const claim = claimSnap.data() as EffectClaim;
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
      const originalSnap = await tx.get(ref.collection(RECEIPTS).doc(decision.receiptId));
      if (!originalSnap.exists) throw new Error("finalized effect claim receipt is missing");
      return { duplicate: true, receipt: originalSnap.data() as Receipt };
    }
    const action = job.actions.find((candidate) => candidate.id === receipt.actionId);
    if (!action) throw new Error(`action ${receipt.actionId} not found`);
    if (action.state !== "planned") throw new Error(`action ${receipt.actionId} is not awaiting finalization`);
    action.state = receipt.outcome === "failed" || receipt.outcome === "rejected" ? "failed" : "executed";
    tx.create(ref.collection(RECEIPTS).doc(receipt.id), receipt);
    tx.set(claimRef, decision.claim);
    tx.update(ref, { actions: job.actions, updatedAt: receipt.performedAt });
    return { duplicate: false, receipt };
  });
}

export async function listReceipts(jobId: string): Promise<Receipt[]> {
  const snaps = await jobRef(jobId)
    .collection(RECEIPTS)
    .orderBy("performedAt", "asc")
    .get();
  return snaps.docs.map((d) => d.data() as Receipt);
}

export interface VerifiedPublication {
  publicationId: string;
  jobId: string;
  actionId: string;
  platform: "x";
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
      drafts?: PostDraft[];
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
      const draft = jobData.drafts?.find((candidate) => candidate.text === actionText);
      const text = actionText || draft?.text || action?.title || "";
      if (!text.toLowerCase().includes(normalized)) continue;
      publications.push({
        publicationId: String(receipt.detail.id ?? receipt.id),
        jobId: job.id,
        actionId: receipt.actionId,
        platform: "x",
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
  const snaps = await jobRef(jobId)
    .collection(RECEIPTS)
    .where("idempotencyKey", "==", key)
    .limit(1)
    .get();
  return snaps.empty ? null : (snaps.docs[0].data() as Receipt);
}

export async function writeReplayObservation(observation: ReplayObservation): Promise<void> {
  await jobRef(observation.jobId).collection(REPLAY_OBSERVATIONS).doc(observation.id).set(observation);
}

export async function listReplayObservations(jobId: string): Promise<ReplayObservation[]> {
  const snaps = await jobRef(jobId).collection(REPLAY_OBSERVATIONS).orderBy("attemptedAt", "asc").get();
  return snaps.docs.map((doc) => doc.data() as ReplayObservation);
}

export async function claimEffect(input: EffectClaimInput): Promise<EffectClaimOutcome> {
  const ref = jobRef(input.jobId);
  const claimRef = ref.collection(EFFECT_CLAIMS).doc(input.idempotencyKey);
  const approvalRef = ref.collection(APPROVAL_DECISIONS).doc(input.actionId);
  return db().runTransaction(async (tx) => {
    const [jobSnap, claimSnap, approvalSnap] = await Promise.all([
      tx.get(ref), tx.get(claimRef), tx.get(approvalRef),
    ]);
    const job = requireJobDoc(jobSnap);
    const action = job.actions.find((candidate) => candidate.id === input.actionId);
    if (!action) throw new Error(`action ${input.actionId} not found on job ${input.jobId}`);
    if (action.type !== input.actionType) throw new Error("effect claim action type mismatch");
    if (action.requiresApproval) {
      const approval = approvalSnap.exists ? approvalSnap.data() as ApprovalDecision : null;
      if (
        !approval
        || approval.jobId !== input.jobId
        || approval.actionId !== input.actionId
        || approval.decision !== "approved"
        || approval.payloadDigest !== actionPayloadDigest(action)
        || !["firebase_operator", "telegram_operator"].includes(approval.actorType)
      ) {
        throw new Error("effect claim requires a durable approval decision");
      }
      const expectedChannel = approval.actorType === "firebase_operator" ? "dashboard" : "telegram";
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

    const existing = claimSnap.exists ? claimSnap.data() as EffectClaim : null;
    const decision = decideEffectClaim(existing, input);
    if (decision.outcome !== "execute") return decision;
    if (action.state !== "planned") {
      throw new Error(`action ${input.actionId} is not executable from state '${action.state}'`);
    }
    if (action.requiresApproval && action.approvalState !== "approved") {
      throw new Error(`action ${input.actionId} has no durable approval`);
    }
    if (claimSnap.exists) tx.set(claimRef, decision.claim);
    else tx.create(claimRef, decision.claim);
    return decision;
  });
}

export async function getEffectClaim(jobId: string, idempotencyKey: string): Promise<EffectClaim | null> {
  const snap = await jobRef(jobId).collection(EFFECT_CLAIMS).doc(idempotencyKey).get();
  return snap.exists ? snap.data() as EffectClaim : null;
}

export async function listEffectClaims(jobId: string): Promise<EffectClaim[]> {
  const snaps = await jobRef(jobId).collection(EFFECT_CLAIMS).orderBy("claimedAt", "asc").get();
  return snaps.docs.map((doc) => doc.data() as EffectClaim);
}

export async function saveVerifications(
  jobId: string,
  results: VerificationResult[],
) {
  const ref = jobRef(jobId);
  await db().runTransaction(async (tx) => {
    const [jobSnap, ...receiptSnaps] = await Promise.all([
      tx.get(ref),
      ...results.map((result) => tx.get(ref.collection(RECEIPTS).doc(result.receiptId))),
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
      if (!receiptSnap.exists) throw new Error("verification receipt not found");
      const receipt = receiptSnap.data() as Receipt;
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
      const expectedMethod = receipt.actionType === "publish_x_post"
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
    tx.update(ref, {
      verifications: results,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function savePacket(jobId: string, packet: EvidencePacket) {
  await jobRef(jobId).update({
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
  await jobRef(jobId).update({
    engagement,
    learnings,
    status: "complete",
    stage: "complete",
    terminalOutcome,
    retentionDeleteAfter: retentionDeadline(),
    updatedAt: new Date().toISOString(),
  });
}

export interface PriorInsight {
  jobId: string;
  text: string;
  likes: number;
  reposts: number;
  replies: number;
}

export async function listRecentEngagement(limit = 20): Promise<PriorInsight[]> {
  const snaps = await tenantCollection(JOBS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  const out: PriorInsight[] = [];
  for (const doc of snaps.docs) {
    const data = doc.data() as JobDoc & { engagement?: Engagement[]; drafts?: PostDraft[] };
    for (const e of data.engagement ?? []) {
      const draft = (data.drafts ?? []).find((d) => d.id === e.actionId);
      const action = (data.actions ?? []).find((a) => a.id === e.actionId);
      out.push({
        jobId: doc.id,
        text: draft?.text ?? action?.title ?? e.postId,
        likes: e.likes,
        reposts: e.reposts,
        replies: e.replies,
      });
    }
  }
  return out.sort((a, b) => b.likes - a.likes);
}

export async function markFailed(
  failure: import("./contracts").FailureSubmission,
) {
  await jobRef(failure.jobId).update({
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
  metadata: { operationId?: string; traceId?: string; pubsubMessageId?: string; activity?: StageEvent["activity"] } = {},
): Promise<void> {
  const activity = metadata.activity ? agentActivitySchema.parse(metadata.activity) : undefined;
  const id = newId();
  const traceId = metadata.traceId ?? currentTraceId();
  const operationId = metadata.operationId ?? `${jobId}:${stage}:${id}`;
  const eventMetadata = {
    operationId,
    traceId,
    ...(metadata.pubsubMessageId ? { pubsubMessageId: metadata.pubsubMessageId } : {}),
    ...(activity ? { activity } : {}),
  };
  await jobRef(jobId)
    .collection(EVENTS)
    .doc(id)
    .set({
      jobId,
      at: FieldValue.serverTimestamp(),
      stage,
      message,
      actor,
      ...eventMetadata,
    } satisfies Omit<StageEvent, "id" | "at"> & { at: unknown });
  // Denormalized within the workspace so monitoring remains tenant-isolated.
  await tenantCollection(EVENT_LOG)
    .doc(id)
    .set({ jobId, at: FieldValue.serverTimestamp(), stage, message, actor, ...eventMetadata });
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
  pubsubMessageId?: string;
  activity?: StageEvent["activity"];
}

export async function listEventLog(limit = 300): Promise<EventLogEntry[]> {
  const snaps = await tenantCollection(EVENT_LOG)
    .orderBy("at", "desc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => {
    const data = d.data() as Omit<EventLogEntry, "id" | "at"> & { at?: { toDate(): Date } };
    return {
      id: d.id,
      jobId: data.jobId,
      at: data.at ? data.at.toDate().toISOString() : null,
      stage: data.stage,
      message: data.message,
      actor: data.actor,
      operationId: data.operationId,
      traceId: data.traceId,
      ...(data.pubsubMessageId ? { pubsubMessageId: data.pubsubMessageId } : {}),
      ...(data.activity ? { activity: data.activity } : {}),
    };
  });
}

export async function listEvents(
  jobId: string,
  limit = 200,
): Promise<Array<Omit<StageEvent, "at"> & { at: string | null }>> {
  const snaps = await jobRef(jobId)
    .collection(EVENTS)
    .orderBy("at", "asc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => {
    const data = d.data() as Omit<StageEvent, "id" | "at"> & { at?: { toDate(): Date } };
    return {
      id: d.id,
      jobId,
      at: data.at ? data.at.toDate().toISOString() : null,
      stage: data.stage,
      message: data.message,
      actor: data.actor,
      operationId: data.operationId,
      traceId: data.traceId,
      ...(data.pubsubMessageId ? { pubsubMessageId: data.pubsubMessageId } : {}),
      ...(data.activity ? { activity: data.activity } : {}),
    };
  });
}
