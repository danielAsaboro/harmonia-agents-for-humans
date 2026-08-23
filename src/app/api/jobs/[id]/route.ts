import { getJob, listAssets, listEvents, listReceipts } from "@/lib/firestore";
import { tenantHandler } from "@/lib/auth";

async function get(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await getJob(id);
  const [events, receipts, assets] = await Promise.all([
    listEvents(id),
    listReceipts(id),
    listAssets(id),
  ]);
  return Response.json({
    job,
    events,
    receipts,
    assets: assets.map((a) => ({
      actionId: a.actionId,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      digest: a.digest,
    })),
  });
}

export const GET = tenantHandler(get);
