import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({
  listJobs: vi.fn(),
  listChatMessages: vi.fn(),
  saveChatMessage: vi.fn(),
}));
const chatIntent = vi.hoisted(() => ({ parseIntent: vi.fn() }));

vi.mock("@/lib/firestore", () => ({
  appendEvent: vi.fn(),
  getJob: vi.fn(),
  listAssets: vi.fn(),
  listChatMessages: firestore.listChatMessages,
  listJobs: firestore.listJobs,
  saveChatMessage: firestore.saveChatMessage,
}));
vi.mock("@/lib/chatIntent", () => ({ parseIntent: chatIntent.parseIntent }));
vi.mock("@/lib/chatAttachments", () => ({ requireReadyAttachments: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/agentAskClient", () => ({ requestAgentAnswer: vi.fn().mockRejectedValue(new Error("agent unavailable")) }));

import { metadata } from "../src/app/layout";
import { handleChat } from "../src/lib/chatHandler";

describe("source-agnostic product copy", () => {
  beforeEach(() => {
    firestore.listJobs.mockResolvedValue([]);
    firestore.listChatMessages.mockResolvedValue([]);
    firestore.saveChatMessage.mockResolvedValue(undefined);
    chatIntent.parseIntent.mockResolvedValue({ intent: "status" });
  });

  it("describes the supported source range in search metadata", () => {
    expect(metadata.description).toContain("video, audio, documents, webpages, and text");
  });

  it("offers multiple ways to begin when chat has no jobs", async () => {
    const response = await handleChat(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "status" }),
    }));

    expect(await response.json()).toMatchObject({
      reply: "No jobs yet. Share a URL, upload a file, paste source material, or describe a content brief to create one.",
    });
  });

  it("offers source-agnostic examples when chat needs to explain its capabilities", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    chatIntent.parseIntent.mockResolvedValue({ intent: "unknown" });
    const response = await handleChat(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "help me get started" }),
    }));

    const payload = await response.json() as { reply: string };
    expect(payload.reply).toContain("content strategy for our startup");
    expect(payload.reply).toContain("Plan the next month");
    expect(payload.reply).toContain("one-off launch announcement");
    expect(payload.reply).not.toContain("x_post");
    errorLog.mockRestore();
  });

  it("invites the operator to connect a recommended but disconnected platform", async () => {
    chatIntent.parseIntent.mockResolvedValue({
      intent: "establish_strategy",
      connectionSuggestions: ["linkedin"],
      workspaceContext: { strategyReady: false },
    });
    const response = await handleChat(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Build our content strategy" }),
    }));
    const payload = await response.json() as { reply: string };
    expect(payload.reply).toContain("LinkedIn is a good fit but not connected yet");
    expect(payload.reply).toContain("Connect it in Settings");
    expect(payload.reply).toContain("still prepare the strategy and drafts now");
  });

  it("keeps connection guidance visible while asking a clarifying question", async () => {
    chatIntent.parseIntent.mockResolvedValue({
      intent: "establish_strategy",
      needsClarification: true,
      clarifyingQuestion: "What outcome should the strategy prioritize?",
      connectionSuggestions: ["linkedin"],
    });
    const response = await handleChat(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Help us plan LinkedIn content" }),
    }));
    const payload = await response.json() as { reply: string };
    expect(payload.reply).toContain("What outcome should the strategy prioritize?");
    expect(payload.reply).toContain("LinkedIn is a good fit but not connected yet");
  });
});
