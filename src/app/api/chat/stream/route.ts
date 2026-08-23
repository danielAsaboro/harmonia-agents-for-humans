import { z } from "zod";
import { tenantHandler } from "@/lib/auth";
import { handleChat, type ChatResponse } from "@/app/api/chat/route";
import { requireReadyAttachments } from "@/lib/chatAttachments";
import { appendChatRunEvent, createChatRun, type UnsequencedChatStreamEvent } from "@/lib/chatRuns";
import { getJob, listAssets, listReceipts } from "@/lib/firestore";
import { generateResponseSurfaces } from "@/lib/a2ui/responseSurface";
import type { JobFull } from "@/components/jobTypes";
import type { HydratedSurfaceSet } from "@/lib/a2ui/hydrateSurfacePlan";

const streamRequestSchema = z.object({
  message: z.string().min(1).max(2_000),
  surface: z.literal("dashboard").default("dashboard"),
  attachmentIds: z.array(z.string().min(1)).max(20).default([]),
}).strict();

const encoder = new TextEncoder();

interface LoadGeneratedPresentationInput {
  runId: string;
  message: string;
  response: ChatResponse;
  loadJob?: typeof getJob;
  loadReceipts?: typeof listReceipts;
  loadAssets?: typeof listAssets;
  generate?: typeof generateResponseSurfaces;
}

export async function loadGeneratedPresentation(input: LoadGeneratedPresentationInput): Promise<{
  job: JobFull;
  surfaces: HydratedSurfaceSet;
  operations: Record<string, unknown>[];
} | null> {
  const jobId = input.response.jobId ?? input.response.job?.id ?? input.response.jobs?.[0]?.id;
  if (!jobId) return null;
  const [persistedJob, receipts, assets] = await Promise.all([
    (input.loadJob ?? getJob)(jobId),
    (input.loadReceipts ?? listReceipts)(jobId),
    (input.loadAssets ?? listAssets)(jobId),
  ]);
  const { packet: persistedPacket, verifications: persistedVerifications, ...persistedJobFields } = persistedJob;
  const job: JobFull = {
    ...persistedJobFields,
    verifications: (persistedVerifications ?? []).map((verification) => ({
      rubricItemId: verification.target,
      verified: verification.verified,
      method: verification.method,
      evidence: verification.evidence,
      ...(verification.note ? { note: verification.note } : {}),
    })),
    ...(persistedPacket ? { packet: {
      generatedAt: persistedPacket.generatedAt,
      unresolved: persistedPacket.unresolved,
      receipts,
    } } : {}),
    assets,
  };
  const surfaces = await (input.generate ?? generateResponseSurfaces)({
    runId: input.runId,
    message: input.message,
    response: input.response,
    job,
    receipts,
  });
  return {
    job,
    surfaces,
    operations: [...surfaces.canvas, ...surfaces.conversation, ...surfaces.approval],
  };
}

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
          const chatResponse = await handleChat(chatRequest, { chatRunId: run.id });
          const payload = await chatResponse.json().catch(() => null) as (ChatResponse & { error?: string }) | null;
          if (!chatResponse.ok || !payload) {
            throw Object.assign(new Error(payload?.error ?? `chat failed (${chatResponse.status})`), { permanent: chatResponse.status >= 400 && chatResponse.status < 500 });
          }
          await emit({ type: "tool_activity", tool: { name: "harmonia_chat_router", status: "complete", outputSummary: `intent=${payload.intent}`, durationMs: Date.now() - toolStartedAt } });
          await emit({ type: "activity", activity: { id: "request-router", label: "Harmonia interpreted the request", status: "complete" } });
          if (payload.job) await emit({ type: "job_updated", jobId: payload.job.id, stage: payload.job.stage, status: payload.job.status });
          const presentationJobId = payload.jobId ?? payload.job?.id ?? payload.jobs?.[0]?.id;
          if (presentationJobId) {
            const presentationStartedAt = Date.now();
            await emit({ type: "activity", activity: { id: "interface-presenter", label: "Maya is composing the campaign workspace", status: "active" } });
            await emit({ type: "tool_activity", tool: { name: "maya_presenter", status: "active", inputSummary: `job=${presentationJobId}, intent=${payload.intent}` } });
            try {
              const presentation = await loadGeneratedPresentation({
                runId: run.id,
                message: parsed.data.message,
                response: payload,
              });
              if (!presentation) throw new Error("presentation job disappeared before hydration");
              await emit({ type: "tool_activity", tool: { name: "maya_presenter", status: "complete", outputSummary: `${presentation.operations.length} validated A2UI operations`, durationMs: Date.now() - presentationStartedAt } });
              await emit({ type: "activity", activity: { id: "interface-presenter", label: "Maya composed the campaign workspace", status: "complete" } });
              for (const operation of presentation.operations) await emit({ type: "a2ui_operation", operation });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await emit({ type: "tool_activity", tool: { name: "maya_presenter", status: "failed", outputSummary: message.slice(0, 2_000), durationMs: Date.now() - presentationStartedAt } });
              await emit({ type: "activity", activity: { id: "interface-presenter", label: "Maya could not compose the campaign workspace", description: message.slice(0, 2_000), status: "failed" } });
              throw error;
            }
          }
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
