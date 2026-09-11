import { operatorTenantHandler } from "@/lib/auth";
import { loadWorkspaceContentContext } from "@/lib/workspaceContentContext";

/** Read-only current-record projection used by the operator workspace. */
export const GET = operatorTenantHandler(async () => Response.json({
  refreshedAt: new Date().toISOString(),
  workspace: await loadWorkspaceContentContext(),
}, { headers: { "cache-control": "no-store" } }));
