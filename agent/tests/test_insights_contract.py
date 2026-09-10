"""TypeScript insight JSON reaches Nimi and Ryan without losing identity."""

from __future__ import annotations

import json
from pathlib import Path

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
    request = stages._strategy_input(_job(), {"topPosts": FIXTURE["topPosts"]})

    assert [item.model_dump(mode="json") for item in request.performance] == [FIXTURE["expectedRyanObservation"]]


def test_typescript_serialized_observation_reaches_nimi_with_its_identity_intact():
    observations = getattr(stages, "_performance_observations_for_nimi", lambda _insights: [])(
        {"topPosts": FIXTURE["topPosts"]}
    )

    assert [item.model_dump(mode="json") for item in observations] == [FIXTURE["expectedNimiObservation"]]


def test_available_observation_does_not_invent_an_optional_impression_count():
    insight = json.loads(json.dumps(FIXTURE["topPosts"][0]))
    del insight["metrics"]["impressions"]

    observation = stages._performance_observations_for_nimi({"topPosts": [insight]})[0]

    assert "impressions" not in observation.summary


def test_verified_metrics_preserve_explicitly_unavailable_published_text():
    insight = json.loads(json.dumps(FIXTURE["topPosts"][0]))
    insight["text"] = None
    insight["textAvailability"] = "unavailable"

    observation = stages._performance_observations_for_nimi({"topPosts": [insight]})[0]

    assert observation.text is None
    assert observation.textAvailability == "unavailable"
    assert "Published text:" not in observation.summary
