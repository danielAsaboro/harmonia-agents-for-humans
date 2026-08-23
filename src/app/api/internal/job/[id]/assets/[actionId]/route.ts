import { getAsset } from "@/lib/firestore";
import { internalTenantHandler } from "@/lib/internalAuth";

/** Metadata read used by the worker's independent verification re-fetch. */
async function get(
  req: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const { id, actionId } = await params;
  const asset = await getAsset(id, actionId);
  if (!asset) {
    return Response.json({ error: "asset not found" }, { status: 404 });
  }
  return Response.json({
    jobId: asset.jobId,
    actionId: asset.actionId,
    mime: asset.mime,
    digest: asset.digest,
    sizeBytes: asset.sizeBytes,
    storageUri: asset.storageUri,
    createdAt: asset.createdAt,
  });
}

export const GET = internalTenantHandler(get);
