import { Firestore, FieldValue } from "@google-cloud/firestore";
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
  Moment,
  Angle,
  Stage,
  StageEvent,
  VerificationResult,
  UsageRecord,
  ApprovalDecision,
  ReplayObservation,
  EffectClaim,
  EffectClaimInput,
  EffectClaimOutcome,
} from "./types";
import { applyFinalizedUsage, applyReservation, canReserve } from "./costs";
import { getConfig } from "./config";
import { actionPayloadDigest, newId } from "./idempotency";
import type { ApprovalActor } from "./decisions";
import {
  assertResourceWorkspace,
  currentTenant,
  tenantCollectionPath,
  tenantSubjectId,
} from "./tenancy";
import { chatScopeKey, retentionPlan, type ChatSurface } from "./chatHistory";
import { currentTraceId } from "./telemetry";
import { decideEffectClaim, decideEffectFinalization } from "./effectClaims";

let client: Firestore | null = null;

export function db(): Firestore {
  if (!client) {
    client = new Firestore();
  }
  return client;
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
  moments?: Moment[];
  angles?: Angle[];
  summary?: string;
  drafts?: PostDraft[];
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

function tenantCollection(name: string) {
  return db().collection(tenantCollectionPath(currentTenant(), name));
}

function initialJobBudget(): JobBudget {
  const config = getConfig();
  return {
    estimatedUsd: "0.00",
    observedUsd: "0.00",
    reservedUsd: "0.00",
    limitUsd: config.DEFAULT_JOB_BUDGET_USD,
    approvalThresholdUsd: config.DEFAULT_JOB_APPROVAL_THRESHOLD_USD,
  };
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
  calendarId?: string;
  calendarTitle?: string;
  calendarProvisionedAt?: string;
  calendarProvisioning?: { status: "claimed" | "uncertain"; claimId: string; at: string };
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
  return snap.data() as ConnectionDoc;
}

export async function saveConnection(conn: ConnectionDoc): Promise<void> {
  await connectionRef(conn.platform).set(conn);
}

export async function deleteConnection(platform: string): Promise<void> {
  await connectionRef(platform).delete();
}

export async function listConnections(): Promise<ConnectionDoc[]> {
  const snaps = await tenantCollection(CONNECTIONS).get();
  return snaps.docs.map((d) => d.data() as ConnectionDoc);
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
}

export async function getTelegramConnection(): Promise<TelegramConnectionDoc | null> {
  const snap = await tenantCollection(CONFIG).doc("telegram").get();
  return snap.exists ? (snap.data() as TelegramConnectionDoc) : null;
}

export async function saveTelegramConnection(connection: TelegramConnectionDoc): Promise<void> {
  await tenantCollection(CONFIG).doc("telegram").set(connection);
}

export async function deleteTelegramConnection(): Promise<void> {
  await tenantCollection(CONFIG).doc("telegram").delete();
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
        jobTitle: data.ingestedTitle ?? data.config?.youtubeUrl ?? doc.id,
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
  moments: Moment[];
  angles: Angle[];
  summary?: string;
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
    stage: data.stage,
    config: data.config,
    failure: data.failure,
    ingestedTitle: data.ingestedTitle,
    ingestedChannel: data.ingestedChannel,
    ingestedDurationSec: data.ingestedDurationSec,
    videoId: data.videoId,
    transcriptSegments: data.transcriptSegments ?? [],
    transcriptLanguage: data.transcriptLanguage,
    moments: data.moments ?? [],
    angles: data.angles ?? [],
    summary: data.summary,
    drafts: data.drafts ?? [],
    contentPack: data.contentPack,
    actions: data.actions ?? [],
    verifications: data.verifications ?? [],
    packet: data.packet,
    budget: data.budget ?? initialJobBudget(),
  };
}

export async function createJob(
  config: JobConfig,
  initialStage: Stage,
): Promise<Job> {
  const id = newId();
  const now = new Date().toISOString();
  const storedConfig: JobConfig = { ...config };
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
  await jobRef(id).set(doc);
  return { id, ...doc };
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

export interface BudgetReservation {
  jobId: string;
  operationId: string;
  stage: string;
  role: string;
  model: string;
  estimatedCostUsd: string;
  pricingVersion: string;
  modelPolicy?: import("./types").ModelPolicySnapshot;
  accepted: boolean;
  finalized: boolean;
  createdAt: string;
}

export async function reserveJobBudget(
  input: Omit<BudgetReservation, "accepted" | "finalized" | "createdAt">,
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
      limitUsd: getConfig().DEFAULT_WORKSPACE_BUDGET_USD,
      approvalThresholdUsd: budget.approvalThresholdUsd,
    };
    const accepted = canReserve(budget, input.estimatedCostUsd)
      && canReserve(workspaceBudget, input.estimatedCostUsd);
    const reservation: BudgetReservation = {
      ...input,
      accepted,
      finalized: false,
      createdAt: new Date().toISOString(),
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
    if (reservation.finalized) {
      throw new Error(`cost reservation already finalized by another usage record: ${record.operationId}`);
    }

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
    tx.update(reservationRef, { finalized: true, finalizedAt: new Date().toISOString() });
    tx.update(ref, { budget, updatedAt: new Date().toISOString() });
    tx.update(workspaceRef, {
      budget: finalizedWorkspaceBudget,
      updatedAt: new Date().toISOString(),
    });
    return { duplicate: false };
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
  moments: Moment[],
  angles: Angle[],
  summary: string,
) {
  await jobRef(jobId).update({
    moments,
    angles,
    summary,
    updatedAt: new Date().toISOString(),
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

export async function listApprovalDecisions(jobId: string): Promise<Array<Omit<ApprovalDecision, "actorUserId" | "authenticationId">>> {
  const snaps = await jobRef(jobId).collection(APPROVAL_DECISIONS).orderBy("decidedAt", "asc").get();
  return snaps.docs.map((doc) => {
    const decision = { ...(doc.data() as ApprovalDecision) } as Partial<ApprovalDecision>;
    delete decision.actorUserId;
    delete decision.authenticationId;
    return decision;
  }) as Array<Omit<ApprovalDecision, "actorUserId" | "authenticationId">>;
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
  return db().runTransaction(async (tx) => {
    const [jobSnap, claimSnap] = await Promise.all([tx.get(ref), tx.get(claimRef)]);
    const job = requireJobDoc(jobSnap);
    const action = job.actions.find((candidate) => candidate.id === input.actionId);
    if (!action) throw new Error(`action ${input.actionId} not found on job ${input.jobId}`);
    if (action.type !== input.actionType) throw new Error("effect claim action type mismatch");

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
  await jobRef(jobId).update({
    verifications: results,
    updatedAt: new Date().toISOString(),
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
): Promise<void> {
  await jobRef(jobId).update({
    engagement,
    learnings,
    status: "complete",
    stage: "complete",
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
  metadata: { operationId?: string; traceId?: string; pubsubMessageId?: string } = {},
): Promise<void> {
  const id = newId();
  const traceId = metadata.traceId ?? currentTraceId();
  const operationId = metadata.operationId ?? `${jobId}:${stage}:${id}`;
  const eventMetadata = {
    operationId,
    traceId,
    ...(metadata.pubsubMessageId ? { pubsubMessageId: metadata.pubsubMessageId } : {}),
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
    };
  });
}
