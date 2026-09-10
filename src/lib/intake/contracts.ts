import { z } from "zod";
import { outputKindSchema, strategyContextSchema } from "../contracts";
import { strategyRefSchema } from "../strategy/contracts";
import { strategyDigest } from "../strategyApproval";

export const workPlacementSchema = z.enum(["independent", "existing_plan_item", "new_initiative", "knowledge_only"]);
export const intakeActionSchema = z.enum(["create_job", "establish_strategy", "revise_strategy", "advance_plan"]);
export const intakeMissingFieldSchema = z.enum(["expectedOutcome", "target", "rights", "requestedOutputs", "sources", "strategyContext", "activeStrategy"]);
export const intakeClarificationSchema = z.object({ field: intakeMissingFieldSchema, question: z.string().trim().min(1).max(300) }).strict();
export const sourceHandleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), attachmentId: z.string().min(1) }).strict(),
  z.object({ kind: z.enum(["web", "youtube"]), url: z.string().url() }).strict(),
]);
export const intakeAdviceSchema = z.object({
  action: intakeActionSchema,
  disposition: workPlacementSchema,
  expectedOutcome: z.string().max(500),
  requestedOutputs: z.array(outputKindSchema).max(8),
  sourceHandles: z.array(sourceHandleSchema).max(10),
  targetName: z.string().max(200).optional(),
  strategyContext: strategyContextSchema.optional(),
  clarification: intakeClarificationSchema.nullable().optional(),
  resolvedField: intakeMissingFieldSchema.nullable().optional(),
}).strict();
export type IntakeAdvice = Omit<z.infer<typeof intakeAdviceSchema>, "strategyContext"> & { strategyContext?: import("../types").StrategyContext };
export type IntakeSourceHandle = z.infer<typeof sourceHandleSchema>;
export const intakeSourceKey = (source: IntakeSourceHandle) => strategyDigest(sourceHandleSchema.parse(source));
export type WorkPlacement = z.infer<typeof workPlacementSchema>;
export interface IntakeTarget { campaignId: string; itemId: string; name: string }
export type IntakeMissingField = z.infer<typeof intakeMissingFieldSchema>;
export interface IntakeDraft extends IntakeAdvice {
  id: string; workspaceId: string; brandId: string; subjectId: string;
  conversationId: string; operationId: string; surface: "dashboard" | "telegram";
  originalOperatorBrief: string;
  answers: Array<{ requestId: string; message: string; at: string }>;
  missingFields: IntakeMissingField[];
  question?: string;
  target?: IntakeTarget;
  sourceRights: Record<string, string>;
  state: "clarifying" | "ready" | "ready_for_planning" | "dispatched" | "retained";
  revision: number; idempotencyKey: string;
  strategyBaseRef: z.infer<typeof strategyRefSchema> | null;
  jobId?: string;
  createdAt: string; updatedAt: string;
}

/** Applicability of the host's unconditional intake prerequisites. */
export function intakeRequirementApplies(field: IntakeMissingField, input: IntakeAdvice): boolean {
  switch (field) {
    case "expectedOutcome": return true;
    case "sources": return input.disposition === "knowledge_only";
    case "target": return input.disposition === "existing_plan_item";
    case "rights": return input.sourceHandles.some(source => source.kind === "upload" || source.kind === "youtube");
    case "requestedOutputs": return input.disposition !== "knowledge_only" && input.action === "create_job";
    case "strategyContext": return input.disposition !== "knowledge_only" && ["establish_strategy", "revise_strategy"].includes(input.action);
    case "activeStrategy": return input.disposition !== "knowledge_only" && input.action === "revise_strategy";
  }
}

/** A conditional router question is not disproved by the absence of a blanket prerequisite. */
export function intakeClarificationApplies(field: IntakeMissingField, previous: IntakeAdvice, current: IntakeAdvice): boolean {
  const currentSources = new Set(current.sourceHandles.map(intakeSourceKey));
  const sameSources = previous.sourceHandles.length === currentSources.size
    && previous.sourceHandles.every(source => currentSources.has(intakeSourceKey(source)));
  if (previous.action === current.action && previous.disposition === current.disposition && sameSources) return true;
  // Explicit evidence questions may apply to factual claims in any action.
  if (field === "sources") return true;
  if (field === "strategyContext" && current.action === "create_job") {
    return current.disposition !== "knowledge_only" && current.sourceHandles.length > 0;
  }
  return intakeRequirementApplies(field, current);
}

/** Classification is advisory. Only authorized records passed by the host resolve a target. */
export function evaluateIntake(input: IntakeAdvice & { rightsAttested: boolean }, targets: IntakeTarget[]) {
  const missingFields: IntakeMissingField[] = [];
  let question: string | undefined;
  let target: IntakeTarget | undefined;
  const missing = (field: IntakeMissingField, prompt: string) => { missingFields.push(field); question ??= prompt; };
  if (!input.expectedOutcome.trim()) missing("expectedOutcome", "What purpose or expected outcome should this work serve?");
  if (input.disposition === "existing_plan_item") {
    const name = input.targetName?.trim().toLocaleLowerCase();
    const matches = name ? targets.filter(item => [item.name, item.campaignId, item.itemId, `${item.campaignId}/${item.itemId}`].some(value => value.toLocaleLowerCase() === name)) : [];
    if (matches.length === 1) target = matches[0];
    else missing("target", matches.length > 1 ? `Which planned item do you mean: ${matches.map(item => `${item.campaignId}/${item.itemId}`).join(", ")}?` : "Which authorized campaign and planned item should this work belong to?");
  }
  if (intakeRequirementApplies("rights", input) && !input.rightsAttested) missing("rights", "Please confirm: I confirm I have rights to use this source.");
  if (input.disposition === "knowledge_only") {
    if (!input.sourceHandles.length) missing("sources", "Which source should I retain as knowledge?");
  } else if (intakeRequirementApplies("requestedOutputs", input) && !input.requestedOutputs.length) {
    missing("requestedOutputs", "Which outputs do you want produced?");
  }
  return { missingFields, question, target };
}
