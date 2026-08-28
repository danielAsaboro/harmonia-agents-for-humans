from __future__ import annotations

import asyncio

from harmonia_agent import agents
from harmonia_agent.intent_routing import IntentRoutingInput


def test_natural_channel_mention_gets_live_connection_guidance(monkeypatch):
    async def run(*args, **kwargs):
        return {"intent_route": {
            "intent": "establish_strategy",
            "userOutcome": "Build a founder-led content program for next month",
            "sourceUrls": [],
            "outputConcepts": ["professional_post", "calendar"],
            "platformRecommendations": ["linkedin"],
            "connectionSuggestions": [],
            "assumptions": [],
            "needsClarification": True,
            "clarifyingQuestion": "What does your startup do, and who should the content reach?",
            "requiresRightsAttestation": False,
            "effectRequested": False,
            "effectAuthorized": False,
            "jobId": None,
        }}

    monkeypatch.setattr(agents, "_run_coordinator", run)
    monkeypatch.setattr(agents.web_client, "get_platform_connections", lambda: [
        {"id": "linkedin", "connected": False},
        {"id": "x", "connected": True},
    ])
    value = IntentRoutingInput.model_validate({
        "message": "Can you help me with social media?",
        "attachmentCount": 0,
        "workspaceContext": {
            "strategyReady": False, "planReady": False, "calendarReady": False,
            "pendingApprovalCount": 0, "goals": [], "channels": [],
            "strategySummary": None, "planSummary": None,
            "upcomingItemCount": 0, "recentJobs": [],
        },
    })

    route = asyncio.run(agents.route_intent_with_team(value))

    assert route.intent == "establish_strategy"
    assert route.platformRecommendations == ["linkedin"]
    assert route.connectionSuggestions == ["linkedin"]
