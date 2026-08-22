import { listAllAssets } from "@/lib/firestore";

/** Asset gallery: every generated image / rendered clip across all jobs. */
export async function GET() {
  const assets = await listAllAssets();
  return Response.json({
    assets: assets.map((a) => ({
      actionId: a.actionId,
      jobId: a.jobId,
      mime: a.mime,
      digest: a.digest,
      sizeBytes: a.sizeBytes,
      createdAt: a.createdAt,
    })),
  });
}
