from fastapi.testclient import TestClient

from harmonia_agent import intent_api, main
from harmonia_agent.intent_routing import IntentRoute


def payload():
    return {
        "message": "Plan a month of founder content",
        "attachmentCount": 0,
        "workspaceContext": {
            "strategyReady": False, "planReady": False, "calendarReady": False,
            "pendingApprovalCount": 0, "goals": [], "channels": [], "recentJobs": [],
        },
    }


def test_route_endpoint_requires_internal_auth():
    response = TestClient(main.app).post("/internal/agent/route", json=payload())
    assert response.status_code == 401


def test_route_endpoint_rejects_unscoped_tenant_identifiers():
    response = TestClient(main.app).post("/internal/agent/route", json=payload(), headers={
        "x-harmonia-internal-token": "test-token-not-a-secret",
        "x-workspace-id": "../other", "x-brand-id": "brand-1", "x-user-id": "user-1",
    })
    assert response.status_code == 400


def test_route_endpoint_returns_strict_harmonia_route(monkeypatch):
    async def route(_payload, *, invocation):
        assert invocation.workspace_id == "workspace-1"
        return IntentRoute.model_validate({
            "intent": "establish_strategy", "userOutcome": "Build an ongoing content program",
            "sourceUrls": [], "outputConcepts": [], "assumptions": [],
            "platformRecommendations": [], "connectionSuggestions": [],
            "needsClarification": False, "clarifyingQuestion": None,
            "requiresRightsAttestation": False, "effectRequested": False, "jobId": None,
        })

    monkeypatch.setattr(intent_api, "route_intent_with_team", route)
    response = TestClient(main.app).post("/internal/agent/route", json=payload(), headers={
        "x-harmonia-internal-token": "test-token-not-a-secret",
        "x-workspace-id": "workspace-1", "x-brand-id": "brand-1", "x-user-id": "user-1",
    })
    assert response.status_code == 200
    assert response.json()["intent"] == "establish_strategy"
    assert response.json()["effectAuthorized"] is False
