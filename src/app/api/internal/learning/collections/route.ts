import { internalTenantHandler } from "@/lib/internalAuth";
import { claimDueObservations, completeProviderObservation, recoverLearning } from "@/lib/learning/repository";
import { providerObservationInputSchema } from "@/lib/learning/contracts";

export const GET = internalTenantHandler(async () => {
  await recoverLearning(); return Response.json({ collections: await claimDueObservations() });
});
export const POST = internalTenantHandler(async request => {
  const input = providerObservationInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "invalid observation submission" }, { status: 400 });
  try { return Response.json({ observation: await completeProviderObservation(input.data) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "observation submission failed" }, { status: 409 }); }
});
