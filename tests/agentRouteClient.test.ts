import { describe, expect, it, vi } from "vitest";

import { requestIntentRoute } from "@/lib/agentRouteClient";

const context = { strategyReady: true, planReady: true, calendarReady: false, pendingApprovalCount: 0, goals: [], channels: ["x"], upcomingItemCount: 0, recentJobs: [] };

describe("Harmonia intent route client", () => {
  it("sends natural language and workspace context to the agent service", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      intent: "one_off_content", userOutcome: "Announce the launch", sourceUrls: [],
      outputConcepts: ["short_social_post"], assumptions: [], needsClarification: false,
      platformRecommendations: ["linkedin"], connectionSuggestions: ["linkedin"],
      clarifyingQuestion: null, requiresRightsAttestation: false, effectRequested: false,
      effectAuthorized: false, jobId: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const route = await requestIntentRoute({ message: "Announce our launch", workspaceContext: context, attachmentCount: 0 }, {
      baseUrl: "http://localhost:8080", token: "token", fetchImpl,
      tenant: { workspaceId: "w", brandId: "b", userId: "u" },
    });
    expect(route.intent).toBe("one_off_content");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ message: "Announce our launch", workspaceContext: { strategyReady: true } });
  });

  it("rejects routes that claim to authorize an effect", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      intent: "effect_request", userOutcome: "Publish", sourceUrls: [], outputConcepts: [],
      platformRecommendations: ["x"], connectionSuggestions: [],
      assumptions: [], needsClarification: false, clarifyingQuestion: null,
      requiresRightsAttestation: false, effectRequested: true, effectAuthorized: true, jobId: null,
    }), { status: 200 }));
    await expect(requestIntentRoute({ message: "Publish it", workspaceContext: context, attachmentCount: 0 }, {
      baseUrl: "http://localhost:8080", token: "token", fetchImpl,
      tenant: { workspaceId: "w", brandId: "b", userId: "u" },
    })).rejects.toThrow(/invalid intent route/i);
  });
});
