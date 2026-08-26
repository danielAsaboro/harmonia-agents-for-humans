import { tenantHandler } from "@/lib/auth";
import {
  decodeActivityCursor,
  listAgentActivity,
} from "@/lib/observability/repository";
import {
  observabilityQuerySchema,
  type ObservabilityQuery,
} from "@/lib/observability/schema";

export function parseObservabilityQuery(url: URL): ObservabilityQuery {
  const params = url.searchParams;
  const cursor = params.get("cursor") || undefined;
  if (cursor) decodeActivityCursor(cursor);
  return observabilityQuerySchema.parse({
    types: params.getAll("type").filter(Boolean),
    agent: params.get("agent") || undefined,
    stage: params.get("stage") || undefined,
    outcome: params.get("outcome") || undefined,
    severity: params.get("severity") || undefined,
    model: params.get("model") || undefined,
    tool: params.get("tool") || undefined,
    jobId: params.get("jobId") || undefined,
    traceId: params.get("traceId") || undefined,
    since: params.get("since") || undefined,
    until: params.get("until") || undefined,
    q: params.get("q") || undefined,
    limit: params.has("limit") ? Number(params.get("limit")) : 25,
    cursor,
  });
}

async function get(req: Request) {
  try {
    const filters = parseObservabilityQuery(new URL(req.url));
    return Response.json(await listAgentActivity(filters));
  } catch (error) {
    const message = error instanceof Error && error.message === "invalid observability cursor"
      ? error.message
      : "invalid observability query";
    return Response.json({ error: message }, { status: 400 });
  }
}

export const GET = tenantHandler(get);
