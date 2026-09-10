import type { UIMessageChunk } from "ai";
import type { ChatStreamEvent } from "./contracts";

export interface UIChunkProjectionState { textStarted: boolean }
export const initialUIChunkProjectionState = (): UIChunkProjectionState => ({ textStarted: false });

export function projectDurableEvent(event: ChatStreamEvent, state: UIChunkProjectionState): UIMessageChunk[] {
  const metadata = { type: "message-metadata" as const, messageMetadata: { runId: event.runId, sequence: event.sequence } };
  switch (event.type) {
    case "run_started": return [{ type: "start", messageId: event.runId }, metadata, { type: "start-step" }];
    case "text_delta": {
      const chunks: UIMessageChunk[] = [metadata];
      if (!state.textStarted) { state.textStarted = true; chunks.push({ type: "text-start", id: `${event.runId}:reply` }); }
      chunks.push({ type: "text-delta", id: `${event.runId}:reply`, delta: event.delta });
      return chunks;
    }
    case "activity": return [metadata, { type: "data-harmonia-activity", id: event.activity.id, data: event.activity }];
    case "tool_activity": return [metadata, { type: "data-harmonia-tool-activity", id: event.tool.traceId ?? event.tool.name, data: event.tool }];
    case "ui_message_chunk": return [metadata, event.chunk as UIMessageChunk];
    case "confirmation_requested": return [metadata, { type: "data-harmonia-confirmation", id: event.confirmation.id, data: event.confirmation }];
    case "job_updated": return [metadata, { type: "data-harmonia-job-update", id: `${event.jobId}:${event.sequence}`, data: { jobId: event.jobId, stage: event.stage, status: event.status } }];
    case "run_completed": return [metadata, ...(state.textStarted ? [{ type: "text-end" as const, id: `${event.runId}:reply` }] : []), { type: "finish-step" }, { type: "finish", finishReason: "stop" }];
    case "run_failed": return [metadata, { type: "error", errorText: event.error }, { type: "finish-step" }, { type: "finish", finishReason: "error" }];
  }
}
