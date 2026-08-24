"""Stage integration tests for the ADK judgment entry points."""

from __future__ import annotations

import asyncio
from pathlib import Path
import pytest

from harmonia_agent import stages
from harmonia_agent.agent_models import AnalysisResult, StrategistResult
from harmonia_agent.web_client import EffectClaimInProgress, EffectClaimUncertain


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
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
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
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
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
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
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


def test_ingest_uploaded_media_uses_tenant_scoped_attachment(monkeypatch):
    posts = []
    media = b"uploaded-media"
    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "config": {
            "mediaAttachmentId": "attachment-1",
            "mediaFilename": "founder-demo.mp4",
            "mediaMime": "video/mp4",
            "mediaStorageUri": "gs://bucket/chat-attachments/ws/brand/attachment-1.mp4",
        },
    })
    monkeypatch.setattr(stages, "get_chat_attachment", lambda _id: (media, "video/mp4", "founder-demo.mp4"))
    monkeypatch.setattr(stages.youtube, "probe_audio_duration", lambda _bytes: 42)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_ingest("job-upload"))

    path, payload = posts[0]
    assert path == "/api/internal/ingest"
    assert payload["videoId"] == "attachment-1"
    assert payload["title"] == "founder-demo.mp4"
    assert payload["durationSec"] == 42
    assert payload["mediaBytes"] == len(media)


def test_verify_posts_observed_receipt_and_trace_lineage(monkeypatch):
    posts = []
    digest = "b" * 64
    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "actions": [{"id": "a1", "type": "export_content_pack", "state": "executed"}],
        "contentPack": {"digest": digest},
    })
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [{
        "id": "r1", "actionId": "a1", "detail": {"digest": digest},
    }])
    monkeypatch.setattr(stages, "current_trace_id", lambda: "a" * 32)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_verify("job-1"))

    path, payload = posts[0]
    assert path == "/api/internal/verification"
    result = payload["results"][0]
    assert result["receiptId"] == "r1"
    assert result["operationId"] == "job-1:verify:a1"
    assert result["traceId"] == "a" * 32
    assert result["method"] == "artifact_digest_reread"


def test_content_pack_receipt_carries_the_applied_artifact_digest(monkeypatch):
    posts = []
    job = {
        "stage": "publish", "ingestedTitle": "Launch", "config": {"brief": "Launch"},
        "moments": [], "angles": [], "drafts": [],
        "actions": [{
            "id": "a1", "type": "export_content_pack", "state": "planned",
            "requiresApproval": True, "approvalState": "approved", "payload": {},
        }],
    }
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages, "current_trace_id", lambda: "a" * 32)
    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1})
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_publish("job-1"))

    receipt = next(payload for path, payload in posts if path == "/api/internal/receipt")
    assert receipt["outcome"] == "applied"
    assert receipt["artifact"]["digest"] == receipt["detail"]["digest"]
    assert len(receipt["artifact"]["digest"]) == 64
    assert receipt["claimToken"]


def test_publish_never_enters_effect_adapter_without_execute_claim(monkeypatch):
    calls = []
    job = {
        "stage": "publish", "ingestedTitle": "Launch", "config": {"brief": "Launch"},
        "moments": [], "angles": [], "drafts": [],
        "actions": [{
            "id": "a1", "type": "export_content_pack", "state": "planned",
            "requiresApproval": True, "approvalState": "approved", "payload": {},
        }],
    }
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages.content, "build_content_pack", lambda *_args: calls.append("effect") or "pack")
    monkeypatch.setattr(stages, "web_post", lambda path, payload: calls.append(path))

    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "already_applied", "attempt": 1, "receiptId": "r1"})
    asyncio.run(stages.run_publish("job-1"))
    assert "effect" not in calls

    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "in_progress", "attempt": 1})
    with pytest.raises(EffectClaimInProgress):
        asyncio.run(stages.run_publish("job-1"))
    assert "effect" not in calls

    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "uncertain", "attempt": 1})
    with pytest.raises(EffectClaimUncertain):
        asyncio.run(stages.run_publish("job-1"))
    assert "effect" not in calls


def test_uploaded_media_is_materialized_for_clip_rendering(monkeypatch, tmp_path):
    monkeypatch.setattr(stages, "get_chat_attachment", lambda _id: (b"video", "video/mp4", "demo.mp4"))
    source = stages._materialize_source_video({
        "config": {"mediaAttachmentId": "attachment-1", "mediaFilename": "demo.mp4"},
    }, str(tmp_path))
    assert source == Path(tmp_path) / "source.mp4"
    assert source.read_bytes() == b"video"


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
