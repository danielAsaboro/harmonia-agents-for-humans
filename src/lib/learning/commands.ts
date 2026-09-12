import { z } from "zod";
import { configurePlannedMeasurement } from "../planning/commands";
import { changeProposalInputSchema, configureMeasurementSchema, operatorFeedbackInputSchema, strategyChangeDecisionInputSchema } from "./contracts";
import { createStrategyChangeProposal, decideStrategyChange, recordOperatorFeedback, recordSourceDiscovery } from "./proposals";
import { recordOperatorObservation } from "./repository";

export const learningRequestSchema = z.discriminatedUnion("action", [
  configureMeasurementSchema.extend({ action: z.literal("configure_measurement") }),
  z.object({ action: z.literal("observe"), collectionId: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().min(1).max(100), value: z.number().finite(), evidenceText: z.string().min(1).max(10000) }).strict(),
  operatorFeedbackInputSchema.extend({ action: z.literal("feedback") }),
  z.object({ action: z.literal("source_discovery"), sourceId: z.string().min(1).max(180) }).strict(),
  z.object({ action: z.literal("propose"), proposal: changeProposalInputSchema }).strict(),
  strategyChangeDecisionInputSchema.extend({ action: z.literal("decide") }),
]);

export async function handleLearningCommand(input: z.infer<typeof learningRequestSchema>) {
  if (input.action === "configure_measurement") { const { action: _action, ...command } = input; void _action; return configurePlannedMeasurement(command); }
  if (input.action === "observe") return recordOperatorObservation(input);
  if (input.action === "feedback") { const { action: _action, ...feedback } = input; void _action; return recordOperatorFeedback(feedback); }
  if (input.action === "source_discovery") return recordSourceDiscovery(input.sourceId);
  if (input.action === "propose") return createStrategyChangeProposal(input.proposal);
  return decideStrategyChange(input);
}
