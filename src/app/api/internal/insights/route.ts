import { getGoals } from "@/lib/repository";
import { learningInsights } from "@/lib/learning/repository";
import { internalTenantHandler } from "@/lib/internalAuth";

/** Cross-job reaction insights + operator goals the agent injects into ideation. */
async function get(_req: Request) {
  const [insights, goals] = await Promise.all([learningInsights(), getGoals()]);
  return Response.json({ ...insights, goals });
}

export const GET = internalTenantHandler(get);
