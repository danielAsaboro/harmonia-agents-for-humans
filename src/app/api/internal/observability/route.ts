import { agentActivitySchema } from "@/lib/observability/schema";
import { writeAgentActivity } from "@/lib/observability/repository";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { internalRoute } from "@/lib/internalHandler";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, agentActivitySchema, async (body) => {
    const result = await writeAgentActivity(body);
    return Response.json(result, { status: 201 });
  });
}
