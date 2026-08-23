import {
  appendEvent,
  getJob,
  markActionExecuted,
  recordApproval,
  setStage,
} from "@/lib/firestore";
import { publishStage } from "@/lib/pubsub";
import { currentTenant } from "@/lib/tenancy";

export interface DecisionOutcome {
  ok: boolean;
  note?: string;
  remainingApprovals?: number;
  triggered?: "publish" | "verify";
}

/**
 * Single writer for approval decisions. Shared by the REST decision route,
 * the chat surface, and any other operator surface so every path through
 * the approval gate behaves identically and emits identical events.
 */
export async function resolveDecision(
  jobId: string,
  actionId: string,
  decision: "approved" | "rejected",
  actor: "system" | "agent" | "operator",
): Promise<DecisionOutcome> {
  const jobBefore = await getJob(jobId);
  const action = await recordApproval(jobId, actionId, decision);
  await appendEvent(
    jobId,
    jobBefore.stage,
    `${decision} action '${action.title}' (${action.type})`,
    actor,
  );

  const job = await getJob(jobId);
  if (job.stage !== "awaiting_approval") {
    return { ok: true, note: "job not awaiting approval" };
  }

  const stillPending = job.actions.filter((a) => a.approvalState === "pending");
  if (stillPending.length > 0) {
    return { ok: true, remainingApprovals: stillPending.length };
  }

  const executable = job.actions.filter(
    (a) =>
      a.state === "planned" &&
      (!a.requiresApproval || a.approvalState === "approved"),
  );
  for (const a of job.actions) {
    if (a.approvalState === "rejected" && a.state === "planned") {
      await markActionExecuted(jobId, a.id, "skipped");
      await appendEvent(jobId, "awaiting_approval", `action skipped by rejection: ${a.title}`, "system");
    }
  }

  if (executable.length > 0) {
    await setStage(jobId, "publish");
    await appendEvent(jobId, "draft", `${executable.length} approved action(s) dispatched to publishing`, "system");
    await publishStage(currentTenant(), jobId, "publish");
    return { ok: true, triggered: "publish" };
  }

  await setStage(jobId, "verify");
  await appendEvent(jobId, "awaiting_approval", "no executable actions; proceeding to verification of existing evidence", "system");
  await publishStage(currentTenant(), jobId, "verify");
  return { ok: true, triggered: "verify" };
}
