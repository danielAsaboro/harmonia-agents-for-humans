import { getConfig } from "@/lib/config";

export async function GET() {
  const config = getConfig();
  return Response.json({
    ok: true,
    service: "harmonia-web",
    project: config.GOOGLE_CLOUD_PROJECT,
    region: config.GOOGLE_CLOUD_LOCATION,
    model: config.MODEL_ID,
  });
}
