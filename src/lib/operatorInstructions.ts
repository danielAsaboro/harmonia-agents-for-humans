import { createHash } from "node:crypto";
import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const turnIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const resolvedFieldSchema = z.enum(["expectedOutcome", "target", "rights", "requestedOutputs", "sources", "strategyContext", "activeStrategy", "appendConstraints"]);

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite instruction context value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("unsupported instruction context value");
};
const sha = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export const instructionTurnProvenanceSchema = z.object({
  turnId: turnIdSchema,
  messageDigest: digestSchema,
  resolvedField: resolvedFieldSchema.optional(),
}).strict();

const unsignedInstructionContextSchema = z.object({
  originalOperatorBrief: z.string().min(1).max(20000),
  resolvedInstructions: z.string().min(1).max(20000),
  intakeDraftId: digestSchema,
  intakeRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  answerTurnIds: z.array(turnIdSchema).max(49),
  turnProvenance: z.array(instructionTurnProvenanceSchema).min(1).max(50),
}).strict().superRefine((value, context) => {
  const turnIds = value.turnProvenance.map(turn => turn.turnId);
  if (new Set(turnIds).size !== turnIds.length) context.addIssue({ code: "custom", path: ["turnProvenance"], message: "instruction turn identities must be unique" });
  if (canonical(value.answerTurnIds) !== canonical(turnIds.slice(1))) context.addIssue({ code: "custom", path: ["answerTurnIds"], message: "answer turn identities must match clarification provenance" });
});

export const operatorInstructionContextSchema = unsignedInstructionContextSchema.extend({
  contextDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { contextDigest, ...unsigned } = value;
  if (contextDigest !== sha(unsigned)) context.addIssue({ code: "custom", path: ["contextDigest"], message: "instruction context digest mismatch" });
});
export type OperatorInstructionContext = z.infer<typeof operatorInstructionContextSchema>;

export function sealOperatorInstructionContext(input: {
  draftId: string;
  revision: number;
  originalOperatorBrief: string;
  answers: Array<{ requestId: string; message: string; resolvedField?: z.infer<typeof resolvedFieldSchema> | null }>;
}): OperatorInstructionContext {
  const answers = input.answers.map(answer => ({
    turnId: answer.requestId,
    message: z.string().min(1).max(20000).parse(answer.message),
    messageDigest: sha(answer.message),
    ...(answer.resolvedField ? { resolvedField: answer.resolvedField } : {}),
  }));
  if (!answers.length || answers[0].message !== input.originalOperatorBrief) throw new Error("original operator brief must match the first intake turn");
  const unsigned = unsignedInstructionContextSchema.parse({
    originalOperatorBrief: input.originalOperatorBrief,
    resolvedInstructions: answers.map(answer => answer.message).join("\n\n"),
    intakeDraftId: input.draftId,
    intakeRevision: input.revision,
    answerTurnIds: answers.slice(1).map(answer => answer.turnId),
    turnProvenance: answers.map(({ turnId, messageDigest, resolvedField }) => ({ turnId, messageDigest, ...(resolvedField ? { resolvedField } : {}) })),
  });
  return operatorInstructionContextSchema.parse({ ...unsigned, contextDigest: sha(unsigned) });
}
