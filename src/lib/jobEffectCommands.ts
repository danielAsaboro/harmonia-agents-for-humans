import { createEffectCommand, effectCommandDigest, type EffectCommand, type EffectCommandInput } from "./effectCommands";
import { createCommand, getCommand } from "./effectCommandStore";
import { getJob, listApprovalDecisions } from "./firestore";
import { actionPayloadDigest, contentHash } from "./idempotency";
import type { ApprovalDecision, Job, PlannedAction } from "./types";

type ReadableApproval = Omit<ApprovalDecision, "actorUserId" | "authenticationId">;

export function buildJobActionCommand(
  job: Job,
  action: PlannedAction,
  approval: ReadableApproval | null,
  now = new Date().toISOString(),
): EffectCommand {
  if (action.jobId !== job.id || action.state !== "planned") throw new Error("job action is not executable");
  const currentActionDigest = actionPayloadDigest(action);
  if (action.requiresApproval) {
    if (action.approvalState !== "approved" || !approval || approval.decision !== "approved") {
      throw new Error("approved action decision required");
    }
    if (approval.actionId !== action.id || approval.jobId !== job.id || approval.payloadDigest !== currentActionDigest) {
      throw new Error("approval payload changed");
    }
    if (approval.actorType === "human_operator") throw new Error("legacy approval cannot authorize a new command");
  } else if (action.approvalState !== "not_required") {
    throw new Error("autonomous action policy state is invalid");
  }

  const base = {
    id: "pending",
    workspaceId: job.workspaceId,
    brandId: job.brandId,
    sourceKind: "job_action" as const,
    sourceId: action.id,
    jobId: job.id,
    actionId: action.id,
    actionType: action.type,
    payload: action.payload,
    now,
  };
  const provisional: EffectCommandInput = {
    ...base,
    authorization: { kind: "approval", approvalId: action.id, approvedPayloadDigest: "pending" },
  };
  const commandDigest = effectCommandDigest(provisional);
  const authorization = action.requiresApproval
    ? { kind: "approval" as const, approvalId: approval!.id, approvedPayloadDigest: commandDigest }
    : {
        kind: "mandate" as const,
        mandateId: `job:${job.id}`,
        mandateDigest: contentHash(JSON.stringify({
          policyVersion: "job-safe-actions-v1",
          jobId: job.id,
          createdByUserId: job.createdByUserId,
          config: job.config,
        })),
        authorizedPayloadDigest: commandDigest,
      };
  return createEffectCommand({
    ...base,
    id: `cmd_${contentHash(`${job.id}:${action.id}:${commandDigest}`).slice(0, 40)}`,
    authorization,
  });
}

export async function materializeJobActionCommand(jobId: string, actionId: string): Promise<EffectCommand> {
  const job = await getJob(jobId);
  const action = job.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error("job action not found");
  const approvals = await listApprovalDecisions(jobId);
  const approval = approvals.find((candidate) => candidate.actionId === actionId) ?? null;
  const command = buildJobActionCommand(job, action, approval);
  const existing = await getCommand(command.id);
  if (existing) {
    if (existing.payloadDigest !== command.payloadDigest) throw new Error("existing effect command payload mismatch");
    return existing;
  }
  await createCommand(command);
  return command;
}

export async function materializeExecutableJobCommands(jobId: string): Promise<EffectCommand[]> {
  const job = await getJob(jobId);
  const executable = job.actions.filter((action) => action.state === "planned" && (!action.requiresApproval || action.approvalState === "approved"));
  return Promise.all(executable.map((action) => materializeJobActionCommand(jobId, action.id)));
}
