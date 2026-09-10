import { DataPlaneRepository } from "@/lib/dataPlane/repository";
import { db } from "@/lib/repository";
import { internalTenantHandler } from "@/lib/internalAuth";

async function get(_req: Request, context: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await context.params;
  const repository = new DataPlaneRepository(db());
  const [batch,outcome] = await Promise.all([repository.getBatch(batchId),repository.outcome(batchId)]);
  return Response.json({ batch,outcome });
}

export const GET = internalTenantHandler(get);
