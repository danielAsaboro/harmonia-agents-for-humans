import { tenantHandler } from "@/lib/auth";
import { listChatRunEvents } from "@/lib/chatRuns";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { initialUIChunkProjectionState, projectDurableEvent } from "@/lib/ai-sdk/uiStream";

async function get(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rawAfter = new URL(req.url).searchParams.get("after") ?? "-1";
  const after = Number(rawAfter);
  if (!Number.isInteger(after) || after < -1) return Response.json({ error: "invalid event offset" }, { status: 400 });
  try {
    const events = await listChatRunEvents(id, after);
    if (new URL(req.url).searchParams.get("stream") === "1") {
      const projection = initialUIChunkProjectionState();
      if (after >= 0) projection.textStarted = (await listChatRunEvents(id, -1)).some((event) => event.sequence <= after && event.type === "text_delta");
      const stream = new ReadableStream<UIMessageChunk>({ start(controller) { controller.enqueue({ type: "start", messageId: id }); for (const event of events) for (const chunk of projectDurableEvent(event, projection)) controller.enqueue(chunk); controller.close(); } });
      return createUIMessageStreamResponse({ stream, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ events });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

export const GET = tenantHandler(get);
