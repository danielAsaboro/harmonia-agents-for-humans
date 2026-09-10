import { z } from "zod";
import { operatorTenantHandler } from "@/lib/auth";
import { listLearningContext, recordOperatorObservation } from "@/lib/learning/repository";
import { createStrategyChangeProposal, decideStrategyChange, recordOperatorFeedback, recordSourceDiscovery } from "@/lib/learning/proposals";
import { changeProposalInputSchema, learningContextSchema, configureMeasurementSchema } from "@/lib/learning/contracts";
import { configurePlannedMeasurement, plannedCalendar } from "@/lib/planning/commands";
import { currentPlan } from "@/lib/campaigns/repository";

const schema = z.discriminatedUnion("action", [
  configureMeasurementSchema.extend({ action: z.literal("configure_measurement") }),
  z.object({ action: z.literal("observe"), collectionId: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().min(1).max(100), value: z.number().finite(), evidenceText: z.string().min(1).max(10000) }).strict(),
  z.object({ action: z.literal("feedback"), requestId: z.string().min(1).max(100), text: z.string().min(1).max(10000), sourceIds: z.array(z.string().min(1).max(180)).max(24) }).strict(),
  z.object({ action: z.literal("source_discovery"), sourceId: z.string().min(1).max(180) }).strict(),
  z.object({ action: z.literal("propose"), proposal: changeProposalInputSchema }).strict(),
  z.object({ action: z.literal("decide"), id: z.string().min(1).max(180), revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approved", "rejected"]), feedback: z.string().min(1).max(2000).optional() }).strict(),
]);
export const GET = operatorTenantHandler(async () => {
  const items = await plannedCalendar();
  const plannedItems = await Promise.all(items.filter(item => ["planned", "blocked"].includes(item.lifecycle.status)).map(async item => ({ itemRef: item.ref, expectedPlanRef: (await currentPlan(item.planRef.id)).ref, strategyRef: item.strategyRef, name: item.name, measurements: item.measurements })));
  return Response.json({ ...learningContextSchema.parse(await listLearningContext()), plannedItems });
});
export const POST = operatorTenantHandler(async request => {
  const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return Response.json({ error: "invalid learning request" }, { status: 400 });
  try {
    const input = parsed.data;
    if (input.action === "configure_measurement") { const { action: _action, ...command } = input; void _action; return Response.json(await configurePlannedMeasurement(command)); }
    if (input.action === "observe") return Response.json(await recordOperatorObservation(input));
    if (input.action === "feedback") return Response.json(await recordOperatorFeedback(input));
    if (input.action === "source_discovery") return Response.json(await recordSourceDiscovery(input.sourceId));
    if (input.action === "propose") return Response.json(await createStrategyChangeProposal(input.proposal));
    return Response.json(await decideStrategyChange(input));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "learning authority unavailable" }, { status: 409 }); }
});
