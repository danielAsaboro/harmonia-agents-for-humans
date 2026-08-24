import { getJob, listApprovalDecisions, listAssets, listEffectClaims, listEvents, listReceipts, listReplayObservations, listUsageRecords } from "@/lib/firestore";
import { tenantHandler } from "@/lib/auth";

async function get(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await getJob(id);
  const [events, receipts, assets, decisions, replays, usage, claims] = await Promise.all([
    listEvents(id),
    listReceipts(id),
    listAssets(id),
    listApprovalDecisions(id),
    listReplayObservations(id),
    listUsageRecords(id),
    listEffectClaims(id),
  ]);
  return Response.json({
    job,
    events,
    receipts,
    decisions,
    replays,
    usage,
    claims,
    assets: assets.map((a) => ({
      actionId: a.actionId,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      digest: a.digest,
    })),
  });
}

export const GET = tenantHandler(get);
