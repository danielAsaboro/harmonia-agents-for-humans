import { tenantHandler } from "@/lib/auth";
import { listChatRunChunks, listChatRunEvents } from "@/lib/chatRuns";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";

async function get(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rawAfter = new URL(req.url).searchParams.get("after") ?? "-1";
  const after = Number(rawAfter);
  if (!Number.isInteger(after) || after < -1) return Response.json({ error: "invalid event offset" }, { status: 400 });
  try {
    const events = await listChatRunEvents(id, after);
    if (new URL(req.url).searchParams.get("stream") === "1") {
      const chunks = await listChatRunChunks(id, after);
      const stream = new ReadableStream<UIMessageChunk>({ start(controller) { for (const record of chunks) controller.enqueue(record.chunk); controller.close(); } });
      return createUIMessageStreamResponse({ stream, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ events });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

export const GET = tenantHandler(get);
