import { listChatMessages } from "@/lib/firestore";
import { tenantHandler } from "@/lib/auth";

/** Past operator-chat messages (dashboard + telegram), oldest first. */
async function get(req: Request) {
  const limitParam = Number(new URL(req.url).searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 300) : 100;
  return Response.json({ messages: await listChatMessages(limit) });
}

export const GET = tenantHandler(get);
