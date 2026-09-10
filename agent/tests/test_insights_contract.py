"""TypeScript insight JSON reaches Nimi and Ryan without losing identity."""

from __future__ import annotations

import json
from pathlib import Path
import asyncio

from harmonia_agent import stages


FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "insights-contract.json").read_text()
)


def _job() -> dict:
    return {
        "id": "job-current",
        "strategyRevision": 1,
        "sourceAnalysis": {
            "sourceDigest": "a" * 64,
            "summary": "Source proof.",
            "moments": [{
                "id": "moment-1", "title": "Proof", "startSec": 0, "endSec": 1,
                "hook": "Proof", "quote": "Proof", "sourceSegmentRefs": ["segment-1"],
                "visualEvidenceIds": [], "assumptions": [], "confidence": "high",
            }],
            "angles": [], "assumptions": [], "confidence": "high",
        },
        "config": {"strategyContext": {
            "company": "Harmonia", "product": "content engine", "positioning": "governed",
            "differentiators": ["evidence"], "brandVoice": ["direct"], "exclusions": [],
            "safetyConstraints": [], "businessObjectives": ["demos"],
            "campaignObjectives": ["educate"],
            "audiences": [{"id": "audience-1", "name": "Founders", "pains": ["delay"]}],
            "funnelStage": "consideration", "intendedConversion": "request a demo",
            "requestedChannels": ["x"], "supportedChannels": ["x"], "horizonWeeks": 4,
        }},
    }


def test_typescript_serialized_observation_reaches_ryan_with_its_identity_intact():
    request = stages._strategy_input(_job(), {"topPosts": FIXTURE["inferenceTopPosts"]})

    assert [item.model_dump(mode="json") for item in request.performance] == [FIXTURE["expectedRyanObservation"]]


def test_typescript_serialized_observation_reaches_nimi_with_its_identity_intact():
    observations = getattr(stages, "_performance_observations_for_nimi", lambda _insights: [])(
        {"topPosts": FIXTURE["inferenceTopPosts"]}
    )

    assert [item.model_dump(mode="json") for item in observations] == [FIXTURE["expectedNimiObservation"]]


def test_available_observation_does_not_invent_an_optional_impression_count():
    insight = json.loads(json.dumps(FIXTURE["inferenceTopPosts"][0]))
    del insight["metrics"]["impressions"]

    observation = stages._performance_observations_for_nimi({"topPosts": [insight]})[0]

    assert "impressions" not in observation.summary


def test_verified_metrics_preserve_explicitly_unavailable_published_text():
    insight = json.loads(json.dumps(FIXTURE["inferenceTopPosts"][0]))
    insight["text"] = None
    insight["textAvailability"] = "unavailable"

    observation = stages._performance_observations_for_nimi({"topPosts": [insight]})[0]

    assert observation.text is None
    assert observation.textAvailability == "unavailable"
    assert "Published text:" not in observation.summary


def test_scheduled_collector_omits_unavailable_impressions_before_the_typescript_submission(monkeypatch):
    posted = []
    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "id": "job-1", "workspaceId": "workspace-1", "brandId": "brand-1", "createdByUserId": "user-1",
        "actions": [{"id": "action-1", "type": "publish_x_post", "state": "executed", "payload": {"text": "Verified text"}}],
    })
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [{"id": "receipt-1", "actionId": "action-1", "detail": {"id": "post-1"}}])
    monkeypatch.setattr(stages, "get_connection", lambda _platform: {"accessToken": "token"})
    monkeypatch.setattr(stages.x_client, "get_post_metrics", lambda _post_id, _token: {
        "likes": 12, "replies": 4, "reposts": 3, "quotes": 1, "impressions": None,
    })
    monkeypatch.setattr(stages, "configured_memory", lambda _invocation: None)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posted.append((path, payload)))
    monkeypatch.setattr(stages, "_now", lambda: "2026-09-09T10:15:00.000Z")

    from harmonia_agent.learning_collector import collect_observation
    submission = collect_observation({"id": "a" * 64, "token": "b" * 64, "postId": "post-1", "costAuthorization": {"maximumUsd": "0.01"}, "expiresAt": "2099-01-01T00:00:00Z", "dispatch": {"token": "b" * 64, "expiresAt": "2099-01-01T00:00:00Z"}}, fetch=lambda _: stages.x_client.get_post_metrics("post-1", "token"))
    engagement = submission["metrics"]
    assert submission["checkedAt"].endswith("Z")
    assert "impressions" not in engagement
