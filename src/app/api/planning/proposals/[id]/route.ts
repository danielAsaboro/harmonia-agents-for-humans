import { z } from "zod";
import { tenantHandler } from "@/lib/auth";
import { awsRepository, recordKey } from "@/lib/dynamo";
import { campaignRoot } from "@/lib/campaigns/repository";
import { disposePlanningProposal } from "@/lib/planning/commands";
import { strategyDigest } from "@/lib/strategyApproval";
import { assertResourceWorkspace, currentTenant } from "@/lib/tenancy";

const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
const disposition = z.object({ requestId: z.string().min(1).max(200), expectedAuthorityDigest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.literal("keep_existing_execution") }).strict();
type RouteContext = { params: Promise<{ id: string }> };
export const GET = tenantHandler(async (_req: Request, { params }: RouteContext) => {
  const id = idSchema.parse((await params).id); const row = await awsRepository().read(recordKey(`${campaignRoot()}/planning_proposals/${id}`));
  if (!row.present) return Response.json({ error: "planning proposal not found" }, { status: 404 });
  assertResourceWorkspace(currentTenant(), row.value as { workspaceId: string; brandId: string });
  return Response.json({ proposal: row.value, ...(Array.isArray(row.value?.guarded) ? { dispositionAuthorityDigest: strategyDigest(row.value.guarded) } : {}) });
});
export const POST = tenantHandler(async (req: Request, { params }: RouteContext) => {
  const proposalId = idSchema.parse((await params).id); const input = disposition.parse(await req.json());
  return Response.json(await disposePlanningProposal({ ...input, proposalId }));
});
