import asyncio
import pytest
from harmonia_agent import agents
from harmonia_agent.intent_routing import IntentRoutingInput, source_urls_from_input
from tests.test_intent_routing import context


def test_completed_conversation_does_not_authorize_sources():
    value = IntentRoutingInput(message="Write a new source-free post", workspaceContext=context(), attachmentCount=0,
        recentConversation=[{"role": "user", "text": "Use https://old.example/completed"}])
    assert source_urls_from_input(value) == []


@pytest.mark.parametrize(("message", "model_urls"), [
    ("Write from https://current.example/source", ["https://invented.example/source", "https://current.example/source"]),
    ("Write a new source-free post", ["https://invented.example/source"]),
    ("Write a new source-free post", ["https://old.example/completed"]),
])
def test_router_rejects_any_unsupported_url_without_substituting_history(monkeypatch, message, model_urls):
    async def route(*args, **kwargs):
        return {"intent_classification": {"intent": "one_off_content", "userOutcome": "Recruit founders",
            "sourceUrls": model_urls, "outputConcepts": ["short_social_post"],
            "platformRecommendations": [], "assumptions": [], "needsClarification": False, "clarifyingQuestion": None,
            "requiresRightsAttestation": False, "effectRequested": False}}
    monkeypatch.setattr(agents, "_run_coordinator", route)
    monkeypatch.setattr(agents, "get_social_platform_connections", lambda: {"status": "success", "data": {"platforms": []}})
    value = IntentRoutingInput(message=message, workspaceContext=context(strategyReady=True), attachmentCount=0,
        recentConversation=[{"role": "user", "text": "Use https://old.example/completed"}])
    with pytest.raises(agents.AgentProtocolError, match="source URL"):
        asyncio.run(agents.route_intent_with_team(value))
