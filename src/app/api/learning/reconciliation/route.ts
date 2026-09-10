import { administratorTenantHandler } from "@/lib/auth";
import { observationReconciliationSchema, pendingObservationReconciliations, reconcileObservation } from "@/lib/learning/reconciliation";

export const GET = administratorTenantHandler(async () => Response.json({ collections: await pendingObservationReconciliations() }));
export const POST = administratorTenantHandler(async request => {
  const parsed = observationReconciliationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid reconciliation request" }, { status: 400 });
  try { return Response.json(await reconcileObservation(parsed.data)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "reconciliation authority unavailable" }, { status: 409 }); }
});
