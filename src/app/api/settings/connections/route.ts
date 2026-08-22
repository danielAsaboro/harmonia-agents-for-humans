import { PLATFORMS, platformStatus } from "@/lib/platforms";

/**
 * Live connection status per platform, derived from actual server env config.
 * Never reports "connected" unless the credentials really exist server-side.
 */
export async function GET() {
  return Response.json({
    connections: PLATFORMS.map((def) => ({
      id: def.id,
      label: def.label,
      capabilities: def.capabilities,
      note: def.note,
      docsUrl: def.docsUrl,
      ...platformStatus(def),
    })),
  });
}
