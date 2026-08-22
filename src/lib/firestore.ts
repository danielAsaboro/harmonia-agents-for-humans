import { Firestore, FieldValue } from "@google-cloud/firestore";
import type {
  EvidencePacket,
  Job,
  JobConfig,
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

function db(): Firestore {
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
    status: "complete",
    stage: "complete",
    updatedAt: new Date().toISOString(),
  });
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
