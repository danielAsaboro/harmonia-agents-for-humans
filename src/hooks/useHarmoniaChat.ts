"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { apiFetch } from "@/lib/clientApi";
import { initialChatRunState, type ChatRunState } from "@/lib/ai-sdk/messageReducer";
import { parseChatStreamEvent, type ChatStreamEvent } from "@/lib/ai-sdk/contracts";
import { DurableChatTransport } from "@/lib/ai-sdk/durableChatTransport";
import type { HarmoniaMessage } from "@/components/ai-sdk/HarmoniaMessageRenderer";

interface ReplayChatRunInput {
  runId: string;
  afterSequence: number;
  onEvent: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
  request?: (input: string, init?: RequestInit) => Promise<Response>;
  wait?: () => Promise<void>;
  maxAttempts?: number;
}

export async function replayChatRunUntilTerminal(input: ReplayChatRunInput): Promise<void> {
  const request = input.request ?? apiFetch;
  const wait = input.wait ?? (() => new Promise((resolve) => window.setTimeout(resolve, 750)));
  const maxAttempts = input.maxAttempts ?? 400;
  let lastSequence = input.afterSequence;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (input.signal?.aborted) throw new DOMException("Chat replay cancelled", "AbortError");
    const replay = await request(`/api/chat/runs/${input.runId}/events?after=${lastSequence}`, {
      cache: "no-store",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!replay.ok) throw new Error(`Chat replay failed (${replay.status})`);
    const body = await replay.json() as { events?: unknown[] };
    for (const value of body.events ?? []) {
      const event = parseChatStreamEvent(value);
      if (event.sequence !== lastSequence + 1) {
        throw new Error(`noncontiguous chat replay: expected ${lastSequence + 1}, received ${event.sequence}`);
      }
      input.onEvent(event);
      lastSequence = event.sequence;
      if (event.type === "run_completed" || event.type === "run_failed") return;
    }
    await wait();
  }
  throw new Error("Chat replay did not reach a terminal event before timeout");
}

export function useHarmoniaChat(options: { onRunId?: (runId: string) => void } = {}) {
  const transport = useMemo(() => new DurableChatTransport<HarmoniaMessage>({ onRunId: options.onRunId }), [options.onRunId]);
  const chat = useChat<HarmoniaMessage>({ transport });
  const run = useMemo(() => {
    const message = [...chat.messages].reverse().find((candidate) => candidate.role === "assistant");
    if (!message) return null;
    const metadata = message.metadata ?? { runId: message.id, sequence: -1 };
    const state = initialChatRunState(metadata.runId);
    state.lastSequence = metadata.sequence;
    state.status = chat.status === "error" ? "failed" : chat.status === "ready" ? "complete" : "running";
    for (const part of message.parts) {
      if (part.type === "text") state.text += part.text;
      else if (part.type === "data-harmonia-surface") state.parts.push({ type: part.type, ...(part.id ? { id: part.id } : {}), data: part.data });
      else if (part.type === "data-harmonia-activity") state.activities.push(part.data as ChatRunState["activities"][number]);
      else if (part.type === "data-harmonia-tool-activity") state.tools.push(part.data as ChatRunState["tools"][number]);
      else if (part.type === "data-harmonia-confirmation") state.confirmations.push(part.data as ChatRunState["confirmations"][number]);
      else if (part.type === "data-harmonia-job-update") state.jobUpdates.push({ type: "job_updated", runId: state.runId, sequence: state.lastSequence, ...(part.data as { jobId: string; stage: string; status: string }) });
    }
    if (chat.error) state.error = chat.error.message;
    return state;
  }, [chat.error, chat.messages, chat.status]);
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const send = useCallback(async (message: string, attachmentIds: string[] = [], conversationId = "primary") => {
    await chat.sendMessage({ text: message }, { body: { conversationId, attachmentIds } });
    const assistant = [...chat.messages].reverse().find((candidate) => candidate.role === "assistant");
    const metadata = assistant?.metadata;
    return runRef.current ?? { ...initialChatRunState(metadata?.runId ?? "pending"), status: "complete" as const };
  }, [chat]);

  const cancel = useCallback(() => {
    void chat.stop();
  }, [chat]);

  return { run, send, cancel, clear: () => chat.setMessages([]), messages: chat.messages, resumeStream: chat.resumeStream };
}
