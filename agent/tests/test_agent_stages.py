"""Stage integration tests for the ADK judgment entry points."""

from __future__ import annotations

import asyncio

from harmonia_agent import stages
from harmonia_agent.agent_models import AnalysisResult, StrategistResult


def _analysis() -> dict:
    return {
        "summary": "Useful lesson",
        "moments": [{
            "id": "m1", "title": "Activation", "startSec": 0, "endSec": 0,
            "hook": "Cut the delay", "quote": "Nine days became forty hours.",
        }],
        "angles": [{
            "id": "a1", "kind": "trend", "title": "Speed wins",
            "rationale": "Founders care about activation.",
        }],
    }


def test_understand_brief_routes_through_strategist_without_schema_changes(monkeypatch):
    requests = []
    posts = []

    async def fake_strategy(request):
        requests.append(request)
        return StrategistResult(analysis=AnalysisResult.model_validate(_analysis()))

    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "config": {"brief": "Explain our activation win"},
        "transcriptSegments": [],
    })
    monkeypatch.setattr(stages, "get_insights", lambda: {})
    monkeypatch.setattr(stages, "strategize_with_team", fake_strategy)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_understand("job-1"))

    assert requests[0].task == "brief"
    path, payload = posts[0]
    assert path == "/api/internal/analysis"
    assert set(payload) == {"jobId", "stage", "moments", "angles", "summary", "modelUsed"}


def test_draft_stage_persists_reviewed_drafts_and_deterministic_actions(monkeypatch):
    posts = []
    job = {
        "config": {"brief": "Activation launch"},
        "ingestedTitle": "Activation launch",
        "summary": _analysis()["summary"],
        "moments": _analysis()["moments"],
        "angles": _analysis()["angles"],
    }
    monkeypatch.setenv("HARMONIA_MOCK_AI", "1")
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_insights", lambda: {"goals": {"voice": "direct"}})
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_draft("job-1"))

    path, payload = posts[0]
    assert path == "/api/internal/drafts"
    assert set(payload) == {"jobId", "stage", "drafts", "proposedActions"}
    draft_text = {draft["text"] for draft in payload["drafts"]}
    publish_text = {
        action["payload"]["text"]
        for action in payload["proposedActions"]
        if action["type"] == "publish_x_post"
    }
    assert publish_text <= draft_text
    assert any(action["id"] == "act-content-pack" for action in payload["proposedActions"])
