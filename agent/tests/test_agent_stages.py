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

    async def fake_strategy(request, *, invocation):
        requests.append((request, invocation))
        return StrategistResult(analysis=AnalysisResult.model_validate(_analysis()))

    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "config": {"brief": "Explain our activation win"},
        "transcriptSegments": [],
    })
    monkeypatch.setattr(stages, "get_insights", lambda: {})
    monkeypatch.setattr(stages, "strategize_with_team", fake_strategy)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_understand("job-1"))

    request, invocation = requests[0]
    assert request.task == "brief"
    assert invocation.job_id == "job-1"
    assert invocation.stage == "understand"
    assert invocation.operation_id == "job-1:understand:0"
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


def test_understand_video_passes_direct_source_media_evidence(monkeypatch):
    requests = []
    posts = []

    async def fake_analyze(request, *, invocation):
        requests.append((request, invocation))
        return AnalysisResult.model_validate(_analysis())

    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "config": {"youtubeUrl": "https://www.youtube.com/watch?v=abc12345678"},
        "transcriptSegments": [{"id": "s1", "startSec": 0, "endSec": 5, "text": "hello"}],
        "ingestedTitle": "Demo video",
        "ingestedChannel": "Harmonia",
        "ingestedDurationSec": 60,
        "mediaDigest": "a" * 64,
    })
    monkeypatch.setattr(stages, "get_insights", lambda: {})
    monkeypatch.setattr(stages, "analyze_with_team", fake_analyze)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_understand("job-video"))

    request, invocation = requests[0]
    assert invocation.stage == "understand"
    assert request.media_evidence.video_uri.endswith("abc12345678")
    assert request.media_evidence.duration_sec == 60
    assert request.media_evidence.source_digest == "a" * 64
    assert "hello" in request.transcript


def test_paid_media_actions_are_deterministic_and_reference_reviewed_evidence_only():
    actions = stages.deterministic_generative_media_actions({
        "ingestedTitle": "Activation launch",
        "moments": [{
            "id": "m1", "title": "Dashboard reveal", "visualHook": "Metric rises on screen",
            "startSec": 1, "endSec": 8,
        }],
        "angles": [{
            "id": "a1", "kind": "trend", "title": "Speed wins",
            "rationale": "Founders care about activation.",
        }],
    })

    assert [action["type"] for action in actions] == [
        "generate_veo_broll", "generate_lyria_soundtrack",
    ]
    assert actions[0]["momentId"] == "m1"
    assert actions[0]["payload"]["durationSec"] == 4
    assert actions[1]["payload"]["durationSec"] == 30
    assert all("requiresApproval" not in action for action in actions)
