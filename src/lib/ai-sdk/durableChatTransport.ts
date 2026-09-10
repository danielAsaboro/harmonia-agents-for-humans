import { DefaultChatTransport, type ChatTransport, type UIMessage, type UIMessageChunk } from "ai";

interface DurableChatTransportOptions { fetchImpl?: typeof fetch }

export class DurableChatTransport<MESSAGE extends UIMessage> implements ChatTransport<MESSAGE> {
  private readonly delegate: DefaultChatTransport<MESSAGE>;
  private runId: string | null = null;
  private sequence = -1;

  constructor(options: DurableChatTransportOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.delegate = new DefaultChatTransport<MESSAGE>({
      api: "/api/chat/stream",
      fetch: async (input, init) => {
        const response = await fetchImpl(input, init);
        this.runId = response.headers.get("x-chat-run-id") ?? this.runId;
        return response;
      },
      prepareSendMessagesRequest: ({ messages, body }) => {
        const latest = messages.at(-1);
        const message = latest?.parts.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
        this.sequence = -1;
        return { body: { message, surface: "dashboard", conversationId: body?.conversationId ?? "primary", attachmentIds: body?.attachmentIds ?? [] } };
      },
      // AI SDK reconstructs the in-flight assistant message from its stable ID.
      // Replaying the validated stream replaces that message and cannot duplicate text or surfaces.
      prepareReconnectToStreamRequest: () => ({ api: this.runId ? `/api/chat/runs/${encodeURIComponent(this.runId)}/events?after=-1&stream=1` : "/api/chat/runs/unavailable/events?stream=1" }),
    });
  }

  private observe(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
    return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({ transform: (chunk, controller) => {
      if (chunk.type === "message-metadata" && chunk.messageMetadata && typeof chunk.messageMetadata === "object") {
        const metadata = chunk.messageMetadata as { runId?: unknown; sequence?: unknown };
        if (typeof metadata.runId === "string") this.runId = metadata.runId;
        if (typeof metadata.sequence === "number" && metadata.sequence > this.sequence) this.sequence = metadata.sequence;
      }
      controller.enqueue(chunk);
    } }));
  }

  async sendMessages(options: Parameters<ChatTransport<MESSAGE>["sendMessages"]>[0]) { return this.observe(await this.delegate.sendMessages(options)); }
  async reconnectToStream(options: Parameters<ChatTransport<MESSAGE>["reconnectToStream"]>[0]) {
    if (!this.runId) return null;
    const stream = await this.delegate.reconnectToStream(options);
    return stream ? this.observe(stream) : null;
  }
}
