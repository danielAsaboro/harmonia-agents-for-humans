import { z } from "zod";
import {
  deleteTelegramConnection,
  getTelegramConnection,
  saveTelegramConnection,
} from "@/lib/firestore";
import { administratorTenantHandler } from "@/lib/auth";

const schema = z.object({
  botToken: z.string().min(20).max(256),
  chatId: z.string().regex(/^-?\d+$/),
});

async function get(_req: Request) {
  const connection = await getTelegramConnection();
  return Response.json({
    connected: Boolean(connection),
    chatId: connection?.chatId,
    connectedAt: connection?.connectedAt,
  });
}

async function put(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid Telegram connection" }, { status: 400 });
  await saveTelegramConnection({ ...parsed.data, connectedAt: new Date().toISOString() });
  return Response.json({ ok: true });
}

async function del(_req: Request) {
  await deleteTelegramConnection();
  return Response.json({ ok: true });
}

export const GET = administratorTenantHandler(get);
export const PUT = administratorTenantHandler(put);
export const DELETE = administratorTenantHandler(del);
