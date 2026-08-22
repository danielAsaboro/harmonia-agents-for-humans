import { listChatMessages } from "@/lib/firestore";

/** Past operator-chat messages (dashboard + telegram), oldest first. */
export async function GET(req: Request) {
  const limitParam = Number(new URL(req.url).searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 300) : 100;
  return Response.json({ messages: await listChatMessages(limit) });
}
