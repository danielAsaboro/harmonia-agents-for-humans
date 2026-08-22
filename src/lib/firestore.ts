import { Firestore, FieldValue } from "@google-cloud/firestore";
import type {
  EvidencePacket,
  Finding,
  Job,
  JobConfig,
  Observation,
  PlannedAction,
  Receipt,
  RubricItem,
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
  rubric?: RubricItem[];
  findings?: Finding[];
  actions?: PlannedAction[];
  verifications?: VerificationResult[];
  observations?: Observation[];
  packet?: EvidencePacket;
}

const JOBS = "jobs";
const EVENTS = "events";
const RECEIPTS = "receipts";

function jobRef(jobId: string) {
  return db().collection(JOBS).doc(jobId);
}

function requireJobDoc(snap: FirebaseFirestore.DocumentSnapshot): Job & {
  rubric: RubricItem[];
  findings: Finding[];
  actions: PlannedAction[];
  verifications: VerificationResult[];
  observations: Observation[];
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
    rubric: data.rubric ?? [],
    findings: data.findings ?? [],
    actions: data.actions ?? [],
    verifications: data.verifications ?? [],
    observations: data.observations ?? [],
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
  if (storedConfig.cloudRunUrl === undefined) {
    delete storedConfig.cloudRunUrl;
  }
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

export async function saveObservations(
  jobId: string,
  observations: Observation[],
): Promise<void> {
  await jobRef(jobId).update({
    observations,
    updatedAt: new Date().toISOString(),
  });
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

export async function saveRubric(jobId: string, items: RubricItem[]) {
  await jobRef(jobId).update({
    rubric: items,
    updatedAt: new Date().toISOString(),
  });
}

export async function saveFindings(jobId: string, findings: Finding[]) {
  await jobRef(jobId).update({
    findings,
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
