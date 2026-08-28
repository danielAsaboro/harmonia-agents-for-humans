import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "../recordReplay/integrity";
import type { JobStatus } from "../types";
import { jobDesiredStateSchema, type JobDesiredState } from "./jobShell";

export const jobControlActionSchema = z.enum(["pause", "resume", "cancel"]);
export type JobControlAction = z.infer<typeof jobControlActionSchema>;

export const commandActorSchema = z.object({
  actorType: z.enum(["firebase_operator", "telegram_operator"]),
  subjectId: z.string().min(1).max(128),
  authenticationId: z.string().min(1).max(300),
}).strict();
export type CommandActor = z.infer<typeof commandActorSchema>;

export interface CommandEnvelope {
  commandId: string;
  jobId: string;
  action: JobControlAction;
  expectedControlVersion: number;
  actor: CommandActor;
  receivedAt: string;
  payloadDigest: string;
}

export interface JobControlState {
  jobId: string;
  status: JobStatus;
  desiredState: JobDesiredState;
  controlVersion: number;
}

export type JobControlDecision =
  | { accepted: true; next: JobControlState }
  | { accepted: false; errorCode: "stale_control_version" | "job_terminal" | "job_not_paused" | "job_already_paused" | "job_cancelled"; error: string; next?: undefined };

export interface CreateCommandEnvelopeInput {
  commandId: string;
  jobId: string;
  action: JobControlAction;
  expectedControlVersion: number;
  actor: CommandActor;
  receivedAt: string;
}

function digestPayload(input: CreateCommandEnvelopeInput): string {
  return createHash("sha256").update(canonicalJson({
    commandId: input.commandId,
    jobId: input.jobId,
    action: input.action,
    expectedControlVersion: input.expectedControlVersion,
    actor: input.actor,
    receivedAt: input.receivedAt,
  })).digest("hex");
}

export function createCommandEnvelope(input: CreateCommandEnvelopeInput): CommandEnvelope {
  if (!/^[A-Za-z0-9:_-]{1,300}$/.test(input.commandId)) throw new Error("invalid command id");
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(input.jobId)) throw new Error("invalid command job id");
  jobControlActionSchema.parse(input.action);
  commandActorSchema.parse(input.actor);
  if (!Number.isInteger(input.expectedControlVersion) || input.expectedControlVersion < 0) throw new Error("invalid expected control version");
  if (!Number.isFinite(Date.parse(input.receivedAt))) throw new Error("invalid command receivedAt");
  return { ...input, actor: { ...input.actor }, payloadDigest: digestPayload(input) };
}

function rejected(errorCode: Exclude<JobControlDecision, { accepted: true }>["errorCode"], error: string): JobControlDecision {
  return { accepted: false, errorCode, error };
}

export function decideJobControl(state: JobControlState, command: CommandEnvelope): JobControlDecision {
  jobDesiredStateSchema.parse(state.desiredState);
  if (state.jobId !== command.jobId) throw new Error("job control aggregate mismatch");
  if (state.controlVersion !== command.expectedControlVersion) {
    return rejected("stale_control_version", `expected control version ${command.expectedControlVersion}, current version is ${state.controlVersion}`);
  }
  if (state.status === "complete") return rejected("job_terminal", "completed jobs cannot be controlled");
  if (state.desiredState === "cancel_requested") return rejected("job_cancelled", "job cancellation has already been requested");
  let desiredState: JobDesiredState;
  if (command.action === "pause") {
    if (state.desiredState === "pause_requested") return rejected("job_already_paused", "job is already paused");
    desiredState = "pause_requested";
  } else if (command.action === "resume") {
    if (state.desiredState !== "pause_requested") return rejected("job_not_paused", "only paused jobs can be resumed");
    desiredState = "run";
  } else {
    desiredState = "cancel_requested";
  }
  return { accepted: true, next: { ...state, desiredState, controlVersion: state.controlVersion + 1 } };
}
