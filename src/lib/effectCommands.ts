import { createHash } from "node:crypto";

import type { ActionType } from "./types";

export type EffectCommandAuthorization =
  | { kind: "approval"; approvalId: string; approvedPayloadDigest: string }
  | { kind: "mandate"; mandateId: string; mandateDigest: string; authorizedPayloadDigest: string };

export type EffectCommandState = "pending" | "claimed" | "applied" | "failed" | "uncertain" | "cancelled";

export interface EffectCommand {
  id: string;
  workspaceId: string;
  brandId: string;
  sourceKind: "job_action" | "scheduled_content";
  sourceId: string;
  jobId: string;
  actionId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  payloadDigest: string;
  authorization: EffectCommandAuthorization;
  executeAfter?: string;
  state: EffectCommandState;
  createdAt: string;
  updatedAt: string;
  invalidatedReason?: string;
}

export interface EffectCommandInput {
  id: string;
  workspaceId: string;
  brandId: string;
  sourceKind: EffectCommand["sourceKind"];
  sourceId: string;
  jobId: string;
  actionId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  authorization: EffectCommandAuthorization;
  executeAfter?: string;
  now?: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("effect command contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    for (const [, item] of entries) {
      if (item === undefined) throw new Error("effect command contains undefined");
    }
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("effect command contains an unsupported value");
}

export function effectCommandDigest(input: Omit<EffectCommandInput, "authorization" | "now"> | EffectCommandInput | EffectCommand): string {
  return createHash("sha256").update(canonicalJson({
    workspaceId: input.workspaceId,
    brandId: input.brandId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    jobId: input.jobId,
    actionId: input.actionId,
    actionType: input.actionType,
    payload: input.payload,
    executeAfter: input.executeAfter ?? null,
  })).digest("hex");
}

export function createEffectCommand(input: EffectCommandInput): EffectCommand {
  const payloadDigest = effectCommandDigest(input);
  const authorizedDigest = input.authorization.kind === "approval"
    ? input.authorization.approvedPayloadDigest
    : input.authorization.authorizedPayloadDigest;
  if (authorizedDigest !== payloadDigest) {
    throw new Error(input.authorization.kind === "approval"
      ? "approval payload digest mismatch"
      : "mandate payload digest mismatch");
  }
  if (input.authorization.kind === "mandate" && !/^[a-f0-9]{64}$/.test(input.authorization.mandateDigest)) {
    throw new Error("invalid mandate digest");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    brandId: input.brandId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    jobId: input.jobId,
    actionId: input.actionId,
    actionType: input.actionType,
    payload: structuredClone(input.payload),
    payloadDigest,
    authorization: structuredClone(input.authorization),
    executeAfter: input.executeAfter,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export function invalidateEffectCommand(command: EffectCommand, reason: string, now = new Date().toISOString()): EffectCommand {
  if (command.state !== "pending") throw new Error(`cannot invalidate ${command.state} effect command`);
  return { ...command, state: "cancelled", invalidatedReason: reason, updatedAt: now };
}

export function decideTerminalOutcome(commands: Array<Pick<EffectCommand, "state">>): "succeeded" | "partial" | "failed" | "unresolved" {
  if (commands.length === 0 || commands.some((command) => command.state === "uncertain" || command.state === "pending" || command.state === "claimed")) {
    return "unresolved";
  }
  const applied = commands.some((command) => command.state === "applied");
  const failed = commands.some((command) => command.state === "failed");
  if (applied && failed) return "partial";
  if (failed) return "failed";
  return "succeeded";
}
