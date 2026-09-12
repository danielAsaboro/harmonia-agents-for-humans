import { operatorTenantHandler } from "@/lib/auth";
import { listLearningContext } from "@/lib/learning/repository";
import { learningContextSchema } from "@/lib/learning/contracts";
import { plannedCalendar } from "@/lib/planning/commands";
import { currentPlan } from "@/lib/campaigns/repository";
import { handleLearningCommand, learningRequestSchema } from "@/lib/learning/commands";
export const GET = operatorTenantHandler(async () => {
  const items = await plannedCalendar();
  const plannedItems = await Promise.all(items.filter(item => ["planned", "blocked"].includes(item.lifecycle.status)).map(async item => ({ itemRef: item.ref, expectedPlanRef: (await currentPlan(item.planRef.id)).ref, strategyRef: item.strategyRef, name: item.name, measurements: item.measurements })));
  return Response.json({ ...learningContextSchema.parse(await listLearningContext()), plannedItems });
});
export const POST = operatorTenantHandler(async request => {
  const parsed = learningRequestSchema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return Response.json({ error: "invalid learning request" }, { status: 400 });
  try {
    return Response.json(await handleLearningCommand(parsed.data));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "learning authority unavailable" }, { status: 409 }); }
});
