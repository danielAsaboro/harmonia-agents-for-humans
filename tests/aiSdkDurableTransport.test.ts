import { describe, expect, it } from "vitest";
import { Chat } from "@ai-sdk/react";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { DurableChatTransport } from "../src/lib/ai-sdk/durableChatTransport";
import type { HarmoniaMessage } from "../src/components/ai-sdk/HarmoniaMessageRenderer";

function response(chunks: UIMessageChunk[], runId = "run-1", fail = false): Response {
  const stream = new ReadableStream<UIMessageChunk>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    if (fail) controller.error(new Error("connection lost")); else controller.close();
  } });
  return createUIMessageStreamResponse({ stream, headers: { "x-chat-run-id": runId } });
}

describe("AI SDK durable chat transport", () => {
  it("reconnects through the React Chat adapter without duplicating text or surfaces", async () => {
    const urls: string[] = [];
    const surface = { type: "data-harmonia-surface" as const, id: "surface-1", data: { surfaceId: "surface-1", slot: "canvas", revision: 1, components: [{ id: "root", component: "Column", children: [] }] } };
    const fetchImpl = async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) return response([
        { type: "start", messageId: "run-1" },
        { type: "message-metadata", messageMetadata: { runId: "run-1", sequence: 0 } },
        { type: "start-step" }, { type: "text-start", id: "reply" },
        { type: "message-metadata", messageMetadata: { runId: "run-1", sequence: 1 } },
        { type: "text-delta", id: "reply", delta: "Hello " },
      ], "run-1");
      return response([
        { type: "start", messageId: "run-1" },
        { type: "message-metadata", messageMetadata: { runId: "run-1", sequence: 0 } },
        { type: "start-step" }, { type: "text-start", id: "reply" },
        { type: "message-metadata", messageMetadata: { runId: "run-1", sequence: 1 } },
        { type: "text-delta", id: "reply", delta: "Hello " },
        { type: "message-metadata", messageMetadata: { runId: "run-1", sequence: 2 } },
        { type: "text-delta", id: "reply", delta: "world" }, surface,
        { type: "message-metadata", messageMetadata: { runId: "run-1", sequence: 3 } },
        { type: "text-end", id: "reply" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" },
      ]);
    };
    const transport = new DurableChatTransport<HarmoniaMessage>({ fetchImpl: fetchImpl as typeof fetch });
    const chat = new Chat<HarmoniaMessage>({ id: "conversation-1", transport });
    await chat.sendMessage({ text: "go" });
    await chat.resumeStream();
    const assistant = chat.messages.find((message) => message.role === "assistant")!;
    expect(assistant.parts.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("Hello world");
    expect(assistant.parts.filter((part) => part.type === "data-harmonia-surface")).toHaveLength(1);
    expect(urls[1]).toContain("after=-1&stream=1");
  });
});
