import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({
  listJobs: vi.fn(),
  listChatMessages: vi.fn(),
  saveChatMessage: vi.fn(),
}));
const chatIntent = vi.hoisted(() => ({ parseIntent: vi.fn() }));
const intake = vi.hoisted(() => ({ submitIntakeTurn: vi.fn(), executeIntakeDraft: vi.fn(), pendingIntakeDraft: vi.fn(), replayIntakeTurn: vi.fn() }));
const sourceRights = vi.hoisted(() => ({ hasRightsAttestation: vi.fn() }));
const chatAttachments = vi.hoisted(() => ({ requireReadyAttachments: vi.fn() }));

vi.mock("@/lib/repository", () => ({
  appendEvent: vi.fn(),
  getJob: vi.fn(),
  listAssets: vi.fn(),
  listChatMessages: firestore.listChatMessages,
  listJobs: firestore.listJobs,
  saveChatMessage: firestore.saveChatMessage,
}));
vi.mock("@/lib/chatIntent", () => ({ parseIntent: chatIntent.parseIntent }));
vi.mock("@/lib/intake/repository", () => ({ pendingIntakeDraft: intake.pendingIntakeDraft, replayIntakeTurn: intake.replayIntakeTurn }));
vi.mock("@/lib/intake/commands", async (original) => ({ ...await original<typeof import("@/lib/intake/commands")>(), submitIntakeTurn: intake.submitIntakeTurn, executeIntakeDraft: intake.executeIntakeDraft }));
vi.mock("@/lib/stageTrigger", () => ({ queueStageTrigger: vi.fn() }));
vi.mock("@/lib/tenancy", () => ({ currentTenant: () => ({ workspaceId: "workspace-local", brandId: "brand-local", principal: { subjectId: "user-local" } }) }));
vi.mock("@/lib/sourceRights", () => ({
  hasRightsAttestation: sourceRights.hasRightsAttestation,
  RIGHTS_ATTESTATION_PHRASE: "I confirm I have rights to use this source",
  sourceRightsAuthorization: () => ({ id: "rights-web" }),
  persistSourceRightsAuthorization: async () => "rights-web",
}));
vi.mock("@/lib/chatAttachments", () => ({ requireReadyAttachments: chatAttachments.requireReadyAttachments }));
vi.mock("@/lib/agentAskClient", () => ({ requestAgentAnswer: vi.fn().mockRejectedValue(new Error("agent unavailable")) }));

import { metadata } from "../src/app/layout";
import { handleChat } from "../src/lib/chatHandler";

describe("source-agnostic product copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intake.pendingIntakeDraft.mockResolvedValue(null);
    intake.replayIntakeTurn.mockResolvedValue(null);
    intake.submitIntakeTurn.mockImplementation(async input => ({ ...input.advice, originalOperatorBrief: input.message, state: "clarifying", question: "What outcome should the strategy prioritize?", id: "draft-1" }));
    intake.executeIntakeDraft.mockImplementation(async draft => draft);
    firestore.listJobs.mockResolvedValue([]);
    firestore.listChatMessages.mockResolvedValue([]);
    firestore.saveChatMessage.mockResolvedValue(undefined);
    chatAttachments.requireReadyAttachments.mockResolvedValue([]);
    sourceRights.hasRightsAttestation.mockReturnValue(false);
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
  it("does not attach a completed request's files to a new request", async () => {
    intake.pendingIntakeDraft.mockResolvedValue({ state: "dispatched", disposition: "knowledge_only", sourceHandles: [{ kind: "upload", attachmentId: "old-file" }] });
    await handleChat(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ message: "status" }) }));
    expect(chatIntent.parseIntent).toHaveBeenCalledWith("status", 0, []);
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
      body: JSON.stringify({ message: "Build our content strategy", requestId: "request-1" }),
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
      body: JSON.stringify({ message: "Help us plan LinkedIn content", requestId: "request-1" }),
    }));
    const payload = await response.json() as { reply: string };
    expect(payload.reply).toContain("What outcome should the strategy prioritize?");
    expect(payload.reply).toContain("LinkedIn is a good fit but not connected yet");
  });

  it("persists the coordinator's inferred strategy context when an ordinary request starts work", async () => {
    const strategyContext = {
      company: "Harmonia", product: "Content operations for startups", positioning: "Evidence-backed content operations",
      differentiators: ["Human approval before effects"], brandVoice: ["clear"], exclusions: [], safetyConstraints: ["No invented claims"],
      businessObjectives: ["Reach startup founders"], campaignObjectives: ["Build awareness"],
      audiences: [{ id: "founders", name: "Startup founders", pains: ["Inconsistent content"] }],
      funnelStage: "awareness", intendedConversion: "Visit the website", requestedChannels: ["linkedin"], supportedChannels: ["linkedin"], horizonWeeks: 4,
    };
    chatIntent.parseIntent.mockResolvedValue({
      intent: "create_job", userOutcome: "Help more founders find us",
      sources: [{ kind: "web", url: "https://example.com" }], desiredOutputs: ["linkedin_post"],
      platformRecommendations: ["linkedin"], strategyContext, workspaceContext: { strategyReady: false },
      requiresRightsAttestation: false,
    });

    const response = await handleChat(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Can you help more founders find us? Here's our site: https://example.com", requestId: "request-1" }),
    }));

    expect(response.status).toBe(200);
    expect(intake.submitIntakeTurn).toHaveBeenCalledWith(expect.objectContaining({
      advice: expect.objectContaining({ strategyContext, requestedOutputs: ["linkedin_post"] }),
      message: "Can you help more founders find us? Here's our site: https://example.com",
    }));
  });

  it("binds a rights confirmation to the prior uploaded source in the same conversation", async () => {
    sourceRights.hasRightsAttestation.mockImplementation((message: string) => message === "I confirm I have rights to use this source");
    chatAttachments.requireReadyAttachments.mockImplementation(async (ids: string[]) => ids.length === 1 ? [{
      id: "attachment-video-1", filename: "launch.mp4", mime: "video/mp4", sizeBytes: 1024,
      workspaceId: "workspace-local", brandId: "brand-local", createdByUserId: "user-local",
      objectName: "chat-attachments/launch.mp4", storageUri: "file://chat-attachments/attachment-video-1", state: "ready",
      createdAt: "2026-09-04T04:07:00.000Z", updatedAt: "2026-09-04T04:07:00.000Z", category: "video",
    }] : []);
    intake.pendingIntakeDraft.mockResolvedValue({ state: "clarifying", action: "create_job", disposition: "independent", expectedOutcome: "Teach founders", requestedOutputs: ["x_post"], sourceHandles: [{ kind: "upload", attachmentId: "attachment-video-1" }], answers: [{ message: "Turn this video into launch content" }], question: "Confirm source rights" });
    chatIntent.parseIntent.mockResolvedValue({ intent: "create_job", userOutcome: "Turn this video into launch content", desiredOutputs: ["x_post"], requiresRightsAttestation: true });

    const response = await handleChat(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "I confirm I have rights to use this source", conversationId: "primary", requestId: "request-1" }),
    }));

    expect(response.status).toBe(200);
    expect(chatIntent.parseIntent).not.toHaveBeenCalled();
    expect(intake.submitIntakeTurn).toHaveBeenCalledWith(expect.objectContaining({ message: "I confirm I have rights to use this source", requestId: "request-1", advice: expect.objectContaining({ expectedOutcome: "Teach founders", requestedOutputs: ["x_post"] }) }));
  });
});
