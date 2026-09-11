import { z } from "zod";
import { tenantHandler } from "@/lib/auth";
import { awsRepository, recordKey } from "@/lib/dynamo";
import { campaignRoot } from "@/lib/campaigns/repository";
import { disposePlanningProposal } from "@/lib/planning/commands";
import { planningDispositionDigest } from "@/lib/planning/dispositions";
import { assertResourceWorkspace, currentTenant } from "@/lib/tenancy";
import { AuthorityError } from "@/lib/authority";

const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
const disposition = z.object({ requestId: z.string().min(1).max(200), expectedAuthorityDigest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["keep_existing_execution", "rebase_to_current_strategy", "accept_source_replacement", "cancel", "reject"]) }).strict();
type RouteContext = { params: Promise<{ id: string }> };
export const GET = tenantHandler(async (_req: Request, { params }: RouteContext) => {
  const id = idSchema.parse((await params).id); const row = await awsRepository().read(recordKey(`${campaignRoot()}/planning_proposals/${id}`));
  if (!row.present) return Response.json({ error: "planning proposal not found" }, { status: 404 });
  assertResourceWorkspace(currentTenant(), row.value as { workspaceId: string; brandId: string });
  return Response.json({ proposal: row.value, ...(Array.isArray(row.value?.guarded) ? { dispositionAuthorityDigest: planningDispositionDigest(row.value!) } : {}) }, { headers: { "cache-control": "no-store" } });
});
export const POST = tenantHandler(async (req: Request, { params }: RouteContext) => {
  const proposalId = idSchema.parse((await params).id); const input = disposition.parse(await req.json());
  try { return Response.json(await disposePlanningProposal({ ...input, proposalId })); }
  catch (error) {
    if (error instanceof AuthorityError) throw error;
    if (error instanceof Error && /authority|stale|changed|pending|reused|revoked|requires|required|outside|unsupported|cannot|prevents|constraints/.test(error.message)) return Response.json({ error: error.message, code: "planning_conflict", refreshRequired: true }, { status: 409 });
    throw error;
  }
});
