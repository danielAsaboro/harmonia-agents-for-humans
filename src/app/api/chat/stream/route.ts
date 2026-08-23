import { z } from "zod";
import { tenantHandler } from "@/lib/auth";
import { handleChat, type ChatResponse } from "@/app/api/chat/route";
import { requireReadyAttachments } from "@/lib/chatAttachments";
import { appendChatRunEvent, createChatRun, type UnsequencedChatStreamEvent } from "@/lib/chatRuns";
import { buildResponseSurface } from "@/lib/a2ui/responseSurface";

const streamRequestSchema = z.object({
  message: z.string().min(1).max(2_000),
  surface: z.literal("dashboard").default("dashboard"),
  attachmentIds: z.array(z.string().min(1)).max(20).default([]),
}).strict();

const encoder = new TextEncoder();

async function post(req: Request): Promise<Response> {
  const parsed = streamRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid streaming chat payload" }, { status: 400 });
  try {
    await requireReadyAttachments(parsed.data.attachmentIds);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
  const run = await createChatRun(parsed.data.message, parsed.data.attachmentIds);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = async (input: UnsequencedChatStreamEvent) => {
        const event = await appendChatRunEvent(run.id, input);
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      void (async () => {
        try {
          await emit({ type: "run_started", startedAt: new Date().toISOString() });
          await emit({ type: "activity", activity: { id: "request-router", label: "Harmonia is interpreting the request", status: "active" } });
          const toolStartedAt = Date.now();
          await emit({ type: "tool_activity", tool: { name: "harmonia_chat_router", status: "active", inputSummary: `${parsed.data.message.length} characters, ${parsed.data.attachmentIds.length} attachments` } });
          const chatHeaders = new Headers(req.headers);
          chatHeaders.delete("content-length");
          const chatRequest = new Request(req.url.replace(/\/stream$/, ""), {
            method: "POST",
            headers: chatHeaders,
            body: JSON.stringify({ message: parsed.data.message, surface: parsed.data.surface, attachmentIds: parsed.data.attachmentIds }),
          });
          const chatResponse = await handleChat(chatRequest);
          const payload = await chatResponse.json().catch(() => null) as (ChatResponse & { error?: string }) | null;
          if (!chatResponse.ok || !payload) {
            throw Object.assign(new Error(payload?.error ?? `chat failed (${chatResponse.status})`), { permanent: chatResponse.status >= 400 && chatResponse.status < 500 });
          }
          await emit({ type: "tool_activity", tool: { name: "harmonia_chat_router", status: "complete", outputSummary: `intent=${payload.intent}`, durationMs: Date.now() - toolStartedAt } });
          await emit({ type: "activity", activity: { id: "request-router", label: "Harmonia interpreted the request", status: "complete" } });
          if (payload.job) await emit({ type: "job_updated", jobId: payload.job.id, stage: payload.job.stage, status: payload.job.status });
          for (const operation of buildResponseSurface(run.id, payload)) await emit({ type: "a2ui_operation", operation });
          for (let offset = 0; offset < payload.reply.length; offset += 512) {
            await emit({ type: "text_delta", delta: payload.reply.slice(offset, offset + 512) });
          }
          await emit({ type: "run_completed", completedAt: new Date().toISOString(), reply: payload.reply });
        } catch (error) {
          const failure = error as Error & { permanent?: boolean };
          try {
            await emit({ type: "run_failed", failedAt: new Date().toISOString(), error: failure.message || String(error), permanent: Boolean(failure.permanent) });
          } finally {
            controller.close();
          }
          return;
        }
        controller.close();
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-chat-run-id": run.id,
    },
  });
}

export const POST = tenantHandler(post);
