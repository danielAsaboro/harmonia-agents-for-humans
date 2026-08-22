import { getAsset } from "@/lib/firestore";
import { getArtifact } from "@/lib/storage";

/** Serves stored assets (generated images, rendered clips) to the dashboard. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const { id, actionId } = await params;
  const asset = await getAsset(id, actionId);
  if (!asset) {
    return Response.json({ error: "asset not found" }, { status: 404 });
  }
  const bytes = await getArtifact(`${id}_${actionId}`);
  if (!bytes) {
    return Response.json({ error: "artifact bytes missing from store" }, { status: 410 });
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": asset.mime,
      "content-length": String(bytes.length),
      "cache-control": "private, max-age=3600",
      "x-content-digest": asset.digest,
    },
  });
}
