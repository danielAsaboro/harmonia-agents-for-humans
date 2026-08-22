import { Firestore, FieldValue } from "@google-cloud/firestore";
import type {
  EvidencePacket,
  Engagement,
  Job,
  JobConfig,
  Learnings,
  PlannedAction,
  Receipt,
  PostDraft,
  Moment,
  Angle,
  Stage,
  StageEvent,
  VerificationResult,
} from "./types";
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
}

const JOBS = "jobs";
const EVENTS = "events";
const RECEIPTS = "receipts";
const ASSETS = "assets";
const CONFIG = "config";
const CONNECTIONS = "connections";

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
  const snaps = await db()
    .collection(CHATS)
    .orderBy("at", "asc")
    .limitToLast(limit)
    .get();
  return snaps.docs.map((d) => {
    const data = d.data() as { surface?: string; role: string; text: string; data?: Record<string, unknown>; at?: { toDate(): Date } };
    return {
      id: d.id,
      surface: data.surface ?? "dashboard",
      role: data.role,
      text: data.text,
      data: data.data,
      at: data.at ? data.at.toDate().toISOString() : null,
    };
  });
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

export async function saveIngestMeta(
  jobId: string,
  meta: { videoId: string; title: string; channel: string; durationSec: number },
) {
  await jobRef(jobId).update({
    videoId: meta.videoId,
    ingestedTitle: meta.title,
    ingestedChannel: meta.channel,
    ingestedDurationSec: meta.durationSec,
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

export async function appendEvent(
  jobId: string,
  stage: Stage,
  message: string,
  actor: StageEvent["actor"],
): Promise<void> {
  await jobRef(jobId)
    .collection(EVENTS)
    .doc(newId())
    .set({
      jobId,
      at: FieldValue.serverTimestamp(),
      stage,
      message,
      actor,
    } satisfies Omit<StageEvent, "id" | "at"> & { at: unknown });
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
