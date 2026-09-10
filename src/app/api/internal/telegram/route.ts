import { getTelegramConnection } from "@/lib/repository";
import { internalTenantHandler } from "@/lib/internalAuth";

async function get(_req: Request) {
  const connection = await getTelegramConnection();
  if (!connection) return Response.json({ error: "Telegram not connected" }, { status: 404 });
  return Response.json({ connection });
}

export const GET = internalTenantHandler(get);
