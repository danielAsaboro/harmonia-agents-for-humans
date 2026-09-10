import { z } from "zod";

import { publishDataWork } from "@/lib/dataPlane/queue";
import { DataPlaneRepository } from "@/lib/dataPlane/repository";
import { db } from "@/lib/repository";
import { internalTenantHandler } from "@/lib/internalAuth";
import { currentTenant } from "@/lib/tenancy";

const bodySchema = z.object({ now: z.string().datetime({ offset: true }) }).strict();

async function post(req: Request, context: { params: Promise<{ batchId: string }> }) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid data-plane dispatch", detail: parsed.error.flatten() }, { status: 400 });
  const { batchId } = await context.params;
  const repository = new DataPlaneRepository(db());
  const { batch, items } = await repository.dispatchable(batchId, parsed.data.now);
  const published = [];
  for (const item of items) {
    const transportMessageId = await publishDataWork(currentTenant(), {
      batchId, itemId: item.id, partitionIndex: item.partitionIndex, processorVersion: item.processorVersion,
      manifestUri: batch.manifest.uri, manifestDigest: batch.manifest.sha256,
    });
    await repository.markDispatched(batchId, item.id, parsed.data.now);
    published.push({ itemId: item.id, transportMessageId });
  }
  return Response.json({ batchId, published });
}

export const POST = internalTenantHandler(post);
