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
} from "./types";
import { applyFinalizedUsage, applyReservation, canReserve } from "./costs";
import { getConfig } from "./config";
import { newId } from "./idempotency";

let client: Firestore | null = null;

export function db(): Firestore {
  if (!client) {
    client = new Firestore();
  }
  return client;
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
const ASSETS = "assets";
const CONFIG = "config";
const CONNECTIONS = "connections";
const CONTENT_ITEMS = "content_items";
const NOTIFICATIONS = "notifications";
const PROPOSALS = "proposals";
const COST_RESERVATIONS = "cost_reservations";
const USAGE_RECORDS = "usage_records";

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
  return db().collection(CONTENT_ITEMS).doc(id);
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

export async function listContentItems(): Promise<import("./types").ContentItem[]> {
  const snaps = await db()
    .collection(CONTENT_ITEMS)
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();
  return snaps.docs.map((d) => d.data() as import("./types").ContentItem);
}

// ---------- notifications ----------

export async function createNotification(n: import("./types").AppNotification): Promise<void> {
  const id = n.id ?? newId();
  await db()
    .collection(NOTIFICATIONS)
    .doc(id)
    .set({ ...n, id, createdAt: n.createdAt || new Date().toISOString() });
}

export async function listNotifications(limit = 100): Promise<import("./types").AppNotification[]> {
  const snaps = await db()
    .collection(NOTIFICATIONS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => d.data() as import("./types").AppNotification);
}

export async function markNotificationRead(id: string): Promise<void> {
  await db().collection(NOTIFICATIONS).doc(id).update({ readAt: new Date().toISOString() });
}

export async function markAllNotificationsRead(): Promise<void> {
  const snaps = await db().collection(NOTIFICATIONS).where("readAt", "==", null).get();
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
  return db().collection(PROPOSALS).doc(id);
}

export async function getProposal(id: string): Promise<ContentProposal | null> {
  const snap = await proposalRef(id).get();
  return snap.exists ? (snap.data() as ContentProposal) : null;
}

export async function saveProposal(p: ContentProposal): Promise<void> {
  await proposalRef(p.id).set(p);
}

export async function listProposals(limit = 100): Promise<ContentProposal[]> {
  const snaps = await db()
    .collection(PROPOSALS)
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
  const snap = await db().collection(AGENT_STATE).doc(key).get();
  return snap.exists ? (snap.data() as AgentStateDoc) : null;
}

export async function setAgentState(key: string, patch: Partial<AgentStateDoc>): Promise<void> {
  await db()
    .collection(AGENT_STATE)
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
}

export function connectionRef(platform: string) {
  return db().collection(CONNECTIONS).doc(platform);
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
  const snaps = await db().collection(CONNECTIONS).get();
  return snaps.docs.map((d) => d.data() as ConnectionDoc);
}

// ---------- operator chat history ----------

const CHATS = "chat_messages";

export interface ChatMessageDoc {
  surface: "dashboard" | "telegram";
  role: "user" | "assistant";
  text: string;
  data?: Record<string, unknown>;
  at?: FirebaseFirestore.FieldValue | string;
}

export async function saveChatMessage(m: Omit<ChatMessageDoc, "at"> & { at?: ChatMessageDoc["at"] }): Promise<void> {
  await db().collection(CHATS).add({ ...m, at: FieldValue.serverTimestamp() });
}

export async function listChatMessages(
  limit = 100,
): Promise<Array<{ id: string; surface: string; role: string; text: string; data?: Record<string, unknown>; at: string | null }>> {
  // orderBy desc + client-side reverse: more portable than limitToLast.
  const snaps = await db()
    .collection(CHATS)
    .orderBy("at", "desc")
    .limit(limit)
    .get();
  return snaps.docs
    .map((d) => {
      const data = d.data() as { surface?: string; role: string; text: string; data?: Record<string, unknown>; at?: { toDate(): Date } };
      return {
        id: d.id,
        surface: data.surface ?? "dashboard",
        role: data.role,
        text: data.text,
        data: data.data,
        at: data.at ? data.at.toDate().toISOString() : null,
      };
    })
    .reverse();
}

export interface OperatorGoals {
  weeklyPostTarget?: number;
  audience?: string;
  voice?: string;
  topics: string[];
}

export async function getGoals(): Promise<OperatorGoals> {
  const snap = await db().collection(CONFIG).doc("operator").get();
  const data = snap.data() as { goals?: OperatorGoals } | undefined;
  return { topics: [], ...data?.goals };
}

export async function saveGoals(goals: OperatorGoals): Promise<void> {
  await db().collection(CONFIG).doc("operator").set({ goals }, { merge: true });
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
  return db().collection(ASSETS).doc(`${jobId}_${actionId}`);
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
  const snaps = await db()
    .collection(ASSETS)
    .where("jobId", "==", jobId)
    .get();
  return snaps.docs.map((d) => d.data() as AssetDoc);
}

export async function listAllAssets(): Promise<AssetDoc[]> {
  const snaps = await db().collection(ASSETS).orderBy("createdAt", "desc").limit(100).get();
  return snaps.docs.map((d) => d.data() as AssetDoc);
}

export interface ReceiptWithJob extends Receipt {
  jobTitle?: string;
}

export async function listRecentReceipts(limit = 200): Promise<ReceiptWithJob[]> {
  const snaps = await db()
    .collection(JOBS)
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
  return db().collection(JOBS).doc(jobId);
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
  return {
    id: snap.id,
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
  const doc: JobDoc = {
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
  const snaps = await db()
    .collection(JOBS)
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
  accepted: boolean;
  finalized: boolean;
  createdAt: string;
}

export async function reserveJobBudget(
  input: Omit<BudgetReservation, "accepted" | "finalized" | "createdAt">,
): Promise<{ reserved: boolean; duplicate: boolean; budget: JobBudget }> {
  const ref = jobRef(input.jobId);
  const reservationRef = ref.collection(COST_RESERVATIONS).doc(input.operationId);
  return db().runTransaction(async (tx) => {
    const [jobSnap, reservationSnap] = await Promise.all([tx.get(ref), tx.get(reservationRef)]);
    const job = requireJobDoc(jobSnap);
    const budget = job.budget ?? initialJobBudget();
    if (reservationSnap.exists) {
      const existing = reservationSnap.data() as BudgetReservation;
      return { reserved: existing.accepted, duplicate: true, budget };
    }

    const accepted = canReserve(budget, input.estimatedCostUsd);
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
    return { reserved: true, duplicate: false, budget: updated };
  });
}

export async function finalizeUsageRecord(record: UsageRecord): Promise<{ duplicate: boolean }> {
  const ref = jobRef(record.jobId);
  const reservationRef = ref.collection(COST_RESERVATIONS).doc(record.operationId);
  const usageRef = ref.collection(USAGE_RECORDS).doc(record.id);
  return db().runTransaction(async (tx) => {
    const [jobSnap, reservationSnap, usageSnap] = await Promise.all([
      tx.get(ref),
      tx.get(reservationRef),
      tx.get(usageRef),
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
    tx.set(usageRef, record);
    tx.update(reservationRef, { finalized: true, finalizedAt: new Date().toISOString() });
    tx.update(ref, { budget, updatedAt: new Date().toISOString() });
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
): Promise<PlannedAction> {
  return db().runTransaction(async (tx) => {
    const ref = jobRef(jobId);
    const snap = await tx.get(ref);
    const job = requireJobDoc(snap);
    const action = job.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`action ${actionId} not found on job ${jobId}`);
    if (action.approvalState !== "pending") {
      throw new Error(
        `action ${actionId} approval state is '${action.approvalState}', expected 'pending'`,
      );
    }
    action.approvalState = decision;
    action.state = decision === "approved" ? "planned" : "skipped";
    tx.update(ref, {
      actions: job.actions,
      updatedAt: new Date().toISOString(),
    });
    return action;
  });
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
  await db()
    .collection(JOBS)
    .doc(receipt.jobId)
    .collection(RECEIPTS)
    .doc(receipt.id)
    .set(receipt);
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
  const snaps = await db()
    .collection(JOBS)
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
  jobId: string,
  stage: Stage,
  error: string,
  permanent: boolean,
) {
  await jobRef(jobId).update({
    status: permanent ? "failed" : "running",
    failure: {
      stage,
      error,
      permanent,
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
): Promise<void> {
  const id = newId();
  await jobRef(jobId)
    .collection(EVENTS)
    .doc(id)
    .set({
      jobId,
      at: FieldValue.serverTimestamp(),
      stage,
      message,
      actor,
    } satisfies Omit<StageEvent, "id" | "at"> & { at: unknown });
  // Denormalized copy so logs are globally queryable/searchable.
  await db()
    .collection(EVENT_LOG)
    .doc(id)
    .set({ jobId, at: FieldValue.serverTimestamp(), stage, message, actor });
}

export interface EventLogEntry {
  id: string;
  jobId: string;
  at: string | null;
  stage: string;
  message: string;
  actor: string;
}

export async function listEventLog(limit = 300): Promise<EventLogEntry[]> {
  const snaps = await db()
    .collection(EVENT_LOG)
    .orderBy("at", "desc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => {
    const data = d.data() as { jobId: string; at?: { toDate(): Date }; stage: string; message: string; actor: string };
    return {
      id: d.id,
      jobId: data.jobId,
      at: data.at ? data.at.toDate().toISOString() : null,
      stage: data.stage,
      message: data.message,
      actor: data.actor,
    };
  });
}

export async function listEvents(
  jobId: string,
  limit = 200,
): Promise<Array<{ at: string | null; stage: Stage; message: string; actor: string }>> {
  const snaps = await jobRef(jobId)
    .collection(EVENTS)
    .orderBy("at", "asc")
    .limit(limit)
    .get();
  return snaps.docs.map((d) => {
    const data = d.data() as { at?: { toDate(): Date }; stage: Stage; message: string; actor: string };
    return {
      at: data.at ? data.at.toDate().toISOString() : null,
      stage: data.stage,
      message: data.message,
      actor: data.actor,
    };
  });
}
