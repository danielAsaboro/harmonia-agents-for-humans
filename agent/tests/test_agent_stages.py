"""Stage integration tests for the ADK judgment entry points."""

from __future__ import annotations

import asyncio
from pathlib import Path
import pytest

from harmonia_agent import stages
from harmonia_agent.agent_models import SourceAnalysis
from harmonia_agent.web_client import EffectClaimInProgress, EffectClaimUncertain
from tests.test_ryan_strategy import strategy as _content_strategy
from tests.test_temi_editorial_plan import plan as _editorial_plan
from tests.test_temi_stages import accepted_package


def _analysis() -> dict:
    return {
        "sourceDigest": "a" * 64,
        "summary": "Useful lesson",
        "moments": [{
            "id": "m1", "title": "Activation", "startSec": 0, "endSec": 0,
            "hook": "Cut the delay", "quote": "Nine days became forty hours.",
            "transcriptSegmentRefs": ["brief-1"], "visualEvidenceIds": [],
            "assumptions": [], "confidence": "high",
        }],
        "angles": [{
            "id": "a1", "kind": "source", "title": "Speed wins",
            "rationale": "The source describes activation speed.",
            "evidenceRefs": ["m1"], "assumptions": [], "confidence": "high",
        }],
        "assumptions": [], "confidence": "high",
    }


def _effect_command(action: dict) -> dict:
    return {
        "id": f"command-{action['id']}",
        "jobId": "job-1",
        "actionId": action["id"],
        "actionType": action["type"],
        "payload": action["payload"],
        "payloadDigest": "b" * 64,
        "state": "pending",
    }


def test_understand_brief_routes_through_nimi_without_strategy(monkeypatch):
    requests = []
    posts = []

    async def fake_analyze(request, *, invocation):
        requests.append((request, invocation))
        result = _analysis()
        result["sourceDigest"] = request.sourceDigest
        result["moments"][0].update(
            quote=request.transcriptSegments[0].text,
            transcriptSegmentRefs=[request.transcriptSegments[0].id],
        )
        return SourceAnalysis.model_validate(result)

    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "config": {"brief": "Explain our activation win"},
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
        "transcriptSegments": [],
    })
    monkeypatch.setattr(stages, "get_insights", lambda: {})
    monkeypatch.setattr(stages, "analyze_with_team", fake_analyze)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_understand("job-1"))

    request, invocation = requests[0]
    assert request.sourceKind == "brief"
    assert request.transcriptSegments[0].text == "Explain our activation win"
    assert request.memoryFacts == []
    assert invocation.job_id == "job-1"
    assert invocation.stage == "understand"
    assert invocation.operation_id == "job-1:understand:0"
    path, payload = posts[0]
    assert path == "/api/internal/analysis"
    assert set(payload) == {"jobId", "stage", "analysis", "analysisDigest", "modelUsed"}


def test_draft_stage_persists_reviewed_drafts_and_deterministic_actions(monkeypatch):
    posts = []
    persisted_plan = _editorial_plan()
    job = {
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
        "config": {"brief": "Activation launch"},
        "ingestedTitle": "Activation launch",
        "sourceAnalysis": _analysis(),
        "strategyDigest": "a" * 64,
        "strategyApproval": {"decision": "approved", "payloadDigest": "a" * 64, "revision": 1, "decidedAt": "2026-08-27T00:00:00Z", "expiresAt": "2099-01-01T00:00:00Z"},
        "contentStrategy": _content_strategy().model_dump(mode="json"),
        "strategyHistory": {"v1": {"strategy": _content_strategy().model_dump(mode="json"), "digest": "a" * 64, "revision": 1}},
        "stage": "draft", "editorialPlan": persisted_plan,
        "editorialPlanDigest": stages.editorial_plan_digest(persisted_plan),
        "selectedNextItemId": persisted_plan["selectedNextItemId"],
        "editorialItemStates": {persisted_plan["selectedNextItemId"]: {"status": "selected"}},
    }
    async def fake_draft(*_args, **_kwargs):
        return accepted_package(_args[0])

    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_insights", lambda: {"goals": {"voice": "direct"}})
    monkeypatch.setattr(stages, "draft_with_team", fake_draft)
    def fake_post(path, payload):
        posts.append((path, payload))
        return {"outcome": "execute"} if payload.get("operation") == "claim" else {"ok": True}
    monkeypatch.setattr(stages, "web_post", fake_post)

    asyncio.run(stages.run_draft("job-1"))

    path, payload = posts[-1]
    assert path == "/api/internal/drafts"
    assert set(payload) == {"jobId", "stage", "operation", "editorialPlanId", "editorialPlanDigest", "editorialItemId", "briefId", "productionTrace", "proposedActions"}
    draft_text = {payload["productionTrace"]["acceptedDraft"]["text"]}
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
        result = _analysis()
        result["sourceDigest"] = request.sourceDigest
        result["moments"][0].update(
            startSec=0, endSec=5, quote="hello",
            transcriptSegmentRefs=["s1"],
        )
        return SourceAnalysis.model_validate(result)

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
    assert request.mediaEvidence.video_uri.endswith("abc12345678")
    assert request.mediaEvidence.duration_sec == 60
    assert request.mediaEvidence.source_digest == "a" * 64
    assert request.transcriptSegments[0].text == "hello"


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
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [_effect_command(job["actions"][0])])
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
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [_effect_command(job["actions"][0])])
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


def test_publish_uses_immutable_command_payload_not_mutable_job_action(monkeypatch):
    posted = []
    receipts = []
    job = {
        "stage": "publish", "actions": [{
            "id": "a1", "type": "publish_x_post", "state": "planned",
            "requiresApproval": True, "approvalState": "approved",
            "payload": {"text": "MUTATED AFTER APPROVAL"},
        }],
    }
    command = _effect_command({"id": "a1", "type": "publish_x_post", "payload": {"text": "Approved copy"}})
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [command])
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages, "get_connection", lambda _platform: {"accessToken": "fresh"})
    monkeypatch.setattr(stages, "production_adapters", lambda _token: {"publish_x_post": lambda payload: posted.append(payload["text"]) or {"outcome": "applied", "detail": {"id": "post-1"}}})
    monkeypatch.setattr("harmonia_agent.web_client.claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1})
    monkeypatch.setattr("harmonia_agent.web_client.post", lambda path, payload: receipts.append((path, payload)))
    monkeypatch.setattr(stages, "web_post", lambda _path, _payload: None)
    monkeypatch.setattr(stages, "current_trace_id", lambda: "a" * 32)

    asyncio.run(stages.run_publish("job-1"))

    assert posted == ["Approved copy"]
    receipt = next(payload for path, payload in receipts if path == "/api/internal/receipt")
    assert receipt["commandId"] == command["id"]
    assert receipt["idempotencyKey"] == command["payloadDigest"]


def test_x_connection_is_refreshed_before_the_effect_claim(monkeypatch):
    order = []
    job = {"stage": "publish", "actions": []}
    command = _effect_command({"id": "a1", "type": "publish_x_post", "payload": {"text": "Approved copy"}})
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [command])
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages, "get_connection", lambda _platform: order.append("connection") or {"accessToken": "fresh"})
    monkeypatch.setattr(stages, "production_adapters", lambda token: {
        "publish_x_post": lambda _payload: order.append(f"provider:{token}") or {"outcome": "applied", "detail": {"id": "post-1"}},
    })
    monkeypatch.setattr("harmonia_agent.web_client.claim_effect", lambda _payload: order.append("claim") or {"outcome": "execute", "attempt": 1})
    monkeypatch.setattr("harmonia_agent.web_client.post", lambda _path, _payload: None)
    monkeypatch.setattr(stages, "web_post", lambda _path, _payload: None)
    monkeypatch.setattr(stages, "current_trace_id", lambda: "a" * 32)

    asyncio.run(stages.run_publish("job-1"))

    assert order[:3] == ["connection", "claim", "provider:fresh"]

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


def test_paid_media_releases_budget_when_state_lookup_fails_before_dispatch(monkeypatch):
    action = {
        "id": "veo-1", "type": "generate_veo_broll",
        "payload": {"prompt": "city", "durationSec": 4, "aspectRatio": "9:16"},
    }
    job = {
        "stage": "publish", "workspaceId": "w1", "brandId": "b1",
        "createdByUserId": "u1", "actions": [action],
    }
    resolutions = []
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [_effect_command(action)])
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1})
    monkeypatch.setattr(stages, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(stages, "get_media_operation", lambda *_args: (_ for _ in ()).throw(RuntimeError("store down")))
    monkeypatch.setattr(stages, "resolve_budget_reservation", resolutions.append)

    with pytest.raises(RuntimeError, match="store down"):
        asyncio.run(stages.run_publish("job-1"))

    assert resolutions[0]["outcome"] == "not_invoked"


def test_paid_media_quarantines_budget_when_provider_times_out(monkeypatch):
    action = {
        "id": "veo-1", "type": "generate_veo_broll",
        "payload": {"prompt": "city", "durationSec": 4, "aspectRatio": "9:16"},
    }
    job = {
        "stage": "publish", "workspaceId": "w1", "brandId": "b1",
        "createdByUserId": "u1", "actions": [action],
    }
    resolutions = []
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [_effect_command(action)])
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1})
    monkeypatch.setattr(stages, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(stages, "get_media_operation", lambda *_args: None)
    monkeypatch.setattr(stages, "get_asset", lambda *_args: None)
    monkeypatch.setattr(stages, "GoogleMediaTransport", lambda **_kwargs: object())
    monkeypatch.setattr(stages.VeoGenerator, "generate", lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError("provider timeout")))
    monkeypatch.setattr(stages, "resolve_budget_reservation", resolutions.append)

    with pytest.raises(TimeoutError, match="provider timeout"):
        asyncio.run(stages.run_publish("job-1"))

    assert resolutions[0]["outcome"] == "uncertain"
