import { internalTenantHandler } from "@/lib/internalAuth";
import { claimDueObservations, completeProviderObservation, recoverLearning, authorizeObservationDispatch, cancelObservationDispatch } from "@/lib/learning/repository";
import { z } from "zod";
import { providerObservationInputSchema } from "@/lib/learning/contracts";

export const GET = internalTenantHandler(async () => {
  await recoverLearning(); return Response.json({ collections: await claimDueObservations() });
});
export const PATCH = internalTenantHandler(async request => {
  const parsed = z.object({ action: z.enum(["dispatch", "cancel"]), collectionId: z.string().regex(/^[a-f0-9]{64}$/), token: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1).max(200).optional() }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid dispatch request" }, { status: 400 });
  const input = parsed.data;
  try { return Response.json({ collection: input.action === "dispatch" ? await authorizeObservationDispatch(input.collectionId, input.token) : await cancelObservationDispatch(input.collectionId, input.token, input.reason ?? "worker_confirmed_no_dispatch") }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "dispatch rejected" }, { status: 409 }); }
});
export const POST = internalTenantHandler(async request => {
  const input = providerObservationInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "invalid observation submission" }, { status: 400 });
  try { return Response.json({ observation: await completeProviderObservation(input.data) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "observation submission failed" }, { status: 409 }); }
});
