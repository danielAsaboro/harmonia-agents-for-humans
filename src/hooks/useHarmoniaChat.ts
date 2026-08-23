"use client";

import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/clientApi";
import { initialChatRunState, reduceChatStreamEvent, type ChatRunState } from "@/lib/a2ui/chatReducer";
import { parseChatStreamEvent, type ChatStreamEvent } from "@/lib/a2ui/contracts";

async function consumeNdjson(response: Response, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
  if (!response.body) throw new Error("chat stream returned no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(parseChatStreamEvent(JSON.parse(line)));
    if (done) break;
  }
  if (buffer.trim()) onEvent(parseChatStreamEvent(JSON.parse(buffer)));
}

export function useHarmoniaChat() {
  const [run, setRun] = useState<ChatRunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (message: string, attachmentIds: string[] = []) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const response = await apiFetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, surface: "dashboard", attachmentIds }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `chat failed (${response.status})`);
    }
    const runId = response.headers.get("x-chat-run-id");
    if (!runId) throw new Error("chat stream omitted run id");
    let current = initialChatRunState(runId);
    setRun(current);
    const apply = (event: ChatStreamEvent) => {
      current = reduceChatStreamEvent(current, event);
      setRun(current);
    };
    try {
      await consumeNdjson(response, apply);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const replay = await apiFetch(`/api/chat/runs/${runId}/events?after=${current.lastSequence}`, { cache: "no-store" });
      if (!replay.ok) throw error;
      const body = await replay.json() as { events: unknown[] };
      for (const event of body.events) apply(parseChatStreamEvent(event));
      if (current.status === "running") throw error;
    }
    return current;
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return { run, send, cancel, clear: () => setRun(null) };
}
