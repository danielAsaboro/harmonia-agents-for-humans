from __future__ import annotations

import pytest
from pydantic import ValidationError

from harmonia_agent.intent_routing import (
    IntentRoute,
    IntentRoutingInput,
    build_intent_routing_skillset,
)


def context(**overrides):
    base = {
        "strategyReady": False,
        "planReady": False,
        "calendarReady": False,
        "pendingApprovalCount": 0,
        "recentJobs": [],
        "goals": [],
        "channels": [],
    }
    return {**base, **overrides}


def test_route_contract_accepts_normal_user_language_without_internal_tags():
    route = IntentRoute.model_validate({
        "intent": "one_off_content",
        "userOutcome": "Announce the launch to founders",
        "sourceUrls": [],
        "outputConcepts": ["short_social_post", "professional_post"],
        "platformRecommendations": ["x", "linkedin"],
        "connectionSuggestions": ["linkedin"],
        "assumptions": ["Use the approved workspace voice."],
        "needsClarification": False,
        "clarifyingQuestion": None,
        "requiresRightsAttestation": False,
        "effectRequested": False,
        "jobId": None,
    })
    assert route.intent == "one_off_content"
    assert "x_post" not in route.model_dump_json()


def test_route_contract_cannot_authorize_an_external_effect():
    with pytest.raises(ValidationError, match="cannot authorize"):
        IntentRoute.model_validate({
            "intent": "effect_request",
            "userOutcome": "Publish the approved launch post",
            "sourceUrls": [],
            "outputConcepts": ["short_social_post"],
            "platformRecommendations": ["x"],
            "connectionSuggestions": [],
            "assumptions": [],
            "needsClarification": False,
            "clarifyingQuestion": None,
            "requiresRightsAttestation": False,
            "effectRequested": True,
            "effectAuthorized": True,
            "jobId": None,
        })


def test_routing_input_is_bounded_and_workspace_context_is_typed():
    payload = IntentRoutingInput.model_validate({
        "message": "Plan next month's founder content from our current strategy",
        "workspaceContext": context(strategyReady=True, goals=["Increase qualified trials"]),
        "attachmentCount": 0,
    })
    assert payload.workspaceContext.strategyReady is True
    assert payload.workspaceContext.goals == ["Increase qualified trials"]


def test_harmonia_routing_skill_is_loadable():
    skillset = build_intent_routing_skillset()
    assert [skill.frontmatter.name for skill in skillset.skills] == ["harmonia-intent-routing"]
    assert "internal output" in skillset.skills[0].instructions.lower()


def test_connection_tool_reports_real_safe_platform_state(monkeypatch):
    from harmonia_agent import intent_routing
    monkeypatch.setattr(intent_routing.web_client, "get_platform_connections", lambda: [
        {"id": "x", "label": "X", "connected": True, "health": "healthy"},
        {"id": "linkedin", "label": "LinkedIn", "connected": False, "health": "not_connected"},
        {"id": "google-drive", "label": "Drive", "connected": True, "health": "healthy"},
    ])
    result = intent_routing.get_social_platform_connections()
    assert result["status"] == "success"
    assert [item["id"] for item in result["data"]["platforms"]] == ["x", "linkedin"]
    assert "token" not in str(result).lower()
