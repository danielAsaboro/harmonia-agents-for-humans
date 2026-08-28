import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({
  listJobs: vi.fn(),
  saveChatMessage: vi.fn(),
}));
const chatIntent = vi.hoisted(() => ({ parseIntent: vi.fn() }));

vi.mock("@/lib/firestore", () => ({
  appendEvent: vi.fn(),
  getJob: vi.fn(),
  listAssets: vi.fn(),
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
    expect(payload.reply).toContain("share a public URL");
    expect(payload.reply).toContain("upload a file");
    expect(payload.reply).toContain("paste source material");
    errorLog.mockRestore();
  });
});
