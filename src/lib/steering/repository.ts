import { randomUUID } from "node:crypto";
import { db, getJob } from "../firestore";
import { currentTenant, tenantSubjectId } from "../tenancy";
import type { JobNudge, NudgeImpact } from "./contracts";
import { jobNudgeSchema } from "./contracts";
import { calculateNudgeImpact } from "./lineage";
import type { Stage } from "../types";

const scopedJob = (jobId: string) => db().doc(`workspaces/${currentTenant().workspaceId}/jobs/${jobId}`);

export async function proposeNudge(jobId: string, input: Pick<JobNudge, "scope" | "contentItemId" | "instruction">): Promise<{ nudge: JobNudge; impact: NudgeImpact }> {
  const job = await getJob(jobId);
  const nudge = jobNudgeSchema.parse({ ...input, id: randomUUID(), jobId, expectedControlEpoch: job.controlEpoch ?? 0, proposedBySubjectId: tenantSubjectId(currentTenant()), proposedAt: new Date().toISOString() });
  const impact = calculateNudgeImpact(job, nudge);
  await scopedJob(jobId).collection("nudges").doc(nudge.id).create({ ...nudge, impact, status: "proposed" });
  return { nudge, impact };
}

export async function applyNudge(jobId: string, nudgeId: string, expectedImpactDigest: string): Promise<number> {
  const ref = scopedJob(jobId);
  return db().runTransaction(async (transaction) => {
    const [jobSnapshot, nudgeSnapshot] = await Promise.all([transaction.get(ref), transaction.get(ref.collection("nudges").doc(nudgeId))]);
    if (!jobSnapshot.exists || !nudgeSnapshot.exists) throw new Error("job or nudge not found");
    const job = jobSnapshot.data()!; const nudge = nudgeSnapshot.data() as JobNudge & { impact: NudgeImpact; status: string };
    if (nudge.status !== "proposed" || nudge.expectedControlEpoch !== (job.controlEpoch ?? 0)) throw new Error("stale steering epoch");
    if (nudge.impact.digest !== expectedImpactDigest) throw new Error("steering impact digest mismatch");
    const epoch = (job.controlEpoch ?? 0) + 1;
    const actions = Array.isArray(job.actions) ? job.actions.map((action: Record<string, unknown>) => action.state === "planned" && action.approvalState === "approved" ? { ...action, approvalState: "pending" } : action) : [];
    const appliedAt = new Date().toISOString(); const steeringInstructions = [...((job.steeringInstructions as unknown[]) ?? []), { nudgeId: nudge.id, scope: nudge.scope, ...(nudge.contentItemId ? { contentItemId: nudge.contentItemId } : {}), instruction: nudge.instruction, appliedAt, controlEpoch: epoch }];
    transaction.update(ref, { controlEpoch: epoch, actions, steeringInstructions, ...(nudge.impact.revokesApprovals ? { strategyApprovalState: "pending" } : {}), updatedAt: appliedAt });
    transaction.update(nudgeSnapshot.ref, { status: "applied", appliedAt, appliedControlEpoch: epoch });
    return epoch;
  });
}

export async function setJobControl(jobId: string, expectedEpoch: number, state: "running" | "paused" | "cancelled", confirmation?: string): Promise<number> {
  if (state === "cancelled" && confirmation !== `CANCEL ${jobId}`) throw new Error(`confirmation must equal CANCEL ${jobId}`);
  const ref = scopedJob(jobId);
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || (snapshot.get("controlEpoch") ?? 0) !== expectedEpoch) throw new Error("stale steering epoch");
    const epoch = expectedEpoch + 1;
    const actions = state === "cancelled" ? ((snapshot.get("actions") as Array<Record<string, unknown>> | undefined) ?? []).map((action) => action.state === "planned" ? { ...action, state: "skipped", approvalState: "rejected" } : action) : snapshot.get("actions");
    transaction.update(ref, { controlEpoch: epoch, controlState: state, actions, ...(state === "cancelled" ? { terminalOutcome: "rejected", status: "complete" } : state === "running" ? { status: "running" } : {}), updatedAt: new Date().toISOString() });
    return epoch;
  });
}

export async function redoJobStage(jobId: string, expectedEpoch: number, targetStage: Stage, confirmation: string): Promise<number> {
  if (confirmation !== `REDO ${targetStage}`) throw new Error(`confirmation must equal REDO ${targetStage}`);
  const ref = scopedJob(jobId);
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref); if (!snapshot.exists || (snapshot.get("controlEpoch") ?? 0) !== expectedEpoch) throw new Error("stale steering epoch");
    const epoch = expectedEpoch + 1; const actions = ((snapshot.get("actions") as Array<Record<string, unknown>> | undefined) ?? []).map((action) => action.state === "planned" ? { ...action, approvalState: "pending" } : action);
    transaction.update(ref, { controlEpoch: epoch, controlState: "running", stage: targetStage, status: "running", actions, strategyApprovalState: targetStage === "strategize" ? "pending" : snapshot.get("strategyApprovalState"), updatedAt: new Date().toISOString() }); return epoch;
  });
}
