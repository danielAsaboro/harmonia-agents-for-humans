import { getConnection } from "@/lib/firestore";
import { internalTenantHandler } from "@/lib/internalAuth";

async function get(
  _req: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  const connection = await getConnection(platform);
  if (!connection) return Response.json({ error: "connection not found" }, { status: 404 });
  return Response.json({ connection });
}

export const GET = internalTenantHandler(get);
