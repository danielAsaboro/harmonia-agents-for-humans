"""Stage integration tests for the ADK judgment entry points."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
import pytest

from harmonia_agent import stages
from harmonia_agent.agent_models import SourceAnalysis
from harmonia_agent.agents import AnalysisRunResult
from harmonia_agent.effect_executor import ExecutionResult
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
            "sourceSegmentRefs": ["brief-1"], "visualEvidenceIds": [],
            "assumptions": [], "confidence": "high",
        }],
        "angles": [{
            "id": "a1", "angleType": "source_insight", "evidenceKind": "source", "title": "Speed wins",
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
        "state": "prepared",
    }


def test_understand_written_source_routes_through_nimi_without_fake_timestamps(monkeypatch):
    requests = []
    posts = []

    async def fake_analyze(request, *, invocation):
        requests.append((request, invocation))
        result = _analysis()
        result["sourceDigest"] = request.sourceDigest
        result["moments"] = []
        result["angles"][0]["evidenceRefs"] = [request.sourceSegments[0].id]
        return AnalysisRunResult(
            analysis=SourceAnalysis.model_validate(result),
            searchEvidence={}, groundingMetadata=None,
        )

    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "id": "job-1", "config": {"sourceManifestId": "manifest-1"},
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
    })
    monkeypatch.setattr(stages, "get_source_manifest", lambda _job_id: {"normalizedSources": [{"sourceId": "source-1", "sourceKind": "document", "title": "Activation brief", "mimeType": "application/pdf", "contentDigest": "a" * 64, "segments": [{"id": "page-1", "text": "Explain our activation win", "digest": "b" * 64, "locator": {"kind": "page_range", "startPage": 1, "endPage": 1}}]}]})
    monkeypatch.setattr(stages, "get_insights", lambda: {})
    monkeypatch.setattr(stages, "analyze_with_team", fake_analyze)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_understand("job-1"))

    request, invocation = requests[0]
    assert request.sourceKind == "document"
    assert request.sourceSegments[0].text == "Explain our activation win"
    assert request.sourceSegments[0].locator.kind == "page_range"
    assert request.memoryFacts == []
    assert invocation.job_id == "job-1"
    assert invocation.stage == "understand"
    assert invocation.operation_id == "job-1:understand:0"
    path, payload = posts[0]
    assert path == "/api/internal/analysis"
    assert set(payload) == {
        "jobId", "stage", "analysis", "analysisDigest", "modelUsed",
        "researchRequest", "searchEvidence", "groundingMetadata",
    }
    assert payload["researchRequest"] is None
    assert payload["searchEvidence"] == []
    assert payload["groundingMetadata"] is None


def test_draft_stage_persists_reviewed_drafts_and_deterministic_actions(monkeypatch):
    posts = []
    persisted_plan = _editorial_plan()
    job = {
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
        "config": {"brief": "Activation launch"},
        "sourceAnalysis": _analysis(),
        "campaignOutputPlan": {"outputs": [{"outputType": "x_post"}, {"outputType": "content_pack"}]},
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


def test_understand_video_passes_typed_time_range_evidence(monkeypatch):
    requests = []
    posts = []

    async def fake_analyze(request, *, invocation):
        requests.append((request, invocation))
        result = _analysis()
        result["sourceDigest"] = request.sourceDigest
        result["moments"][0].update(
            startSec=0, endSec=5, quote="hello",
            sourceSegmentRefs=["source-video:s1"],
        )
        return AnalysisRunResult(
            analysis=SourceAnalysis.model_validate(result),
            searchEvidence={}, groundingMetadata=None,
        )

    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "id": "job-video", "config": {"sourceManifestId": "manifest-video"},
        "workspaceId": "workspace-test", "brandId": "brand-test", "createdByUserId": "user-test",
    })
    monkeypatch.setattr(stages, "get_source_manifest", lambda _job_id: {"normalizedSources": [{"sourceId": "source-video", "sourceKind": "video", "title": "Demo video", "mimeType": "video/mp4", "contentDigest": "a" * 64, "segments": [{"id": "s1", "text": "hello", "digest": "b" * 64, "locator": {"kind": "time_range", "startMs": 0, "endMs": 5000}}]}]})
    monkeypatch.setattr(stages, "get_insights", lambda: {})
    monkeypatch.setattr(stages, "analyze_with_team", fake_analyze)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_understand("job-video"))

    request, invocation = requests[0]
    assert invocation.stage == "understand"
    assert request.sourceIds == ["source-video"]
    assert request.sourceSegments[0].locator.endMs == 5000
    assert request.sourceSegments[0].text == "hello"


def test_extract_uploaded_media_uses_tenant_scoped_attachment(monkeypatch):
    media = b"uploaded-media"
    monkeypatch.setattr(stages, "get_chat_attachment", lambda _id: (media, "video/mp4", "founder-demo.mp4"))
    monkeypatch.setattr(stages, "extract_media", lambda source_id, title, body, mime, **_kwargs: (source_id, title, body, mime))
    result = stages._extract_source({"id": "job-upload", "workspaceId": "w", "brandId": "b", "createdByUserId": "u"}, {"id": "source-upload"}, {"kind": "upload", "attachmentId": "attachment-1"})
    assert result == ("source-upload", "founder-demo.mp4", media, "video/mp4")


@pytest.mark.parametrize(("stored_markdown", "verified"), [
    ("Approved content pack", True),
    ("Tampered after receipt", False),
])
def test_verify_posts_observed_receipt_and_trace_lineage(monkeypatch, stored_markdown, verified):
    posts = []
    approved_markdown = "Approved content pack"
    digest = hashlib.sha256(approved_markdown.encode()).hexdigest()
    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "actions": [{"id": "a1", "type": "export_content_pack", "state": "executed"}],
        "contentPack": {"markdown": stored_markdown, "digest": digest},
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
    assert result["verified"] is verified
    assert result["evidence"]["digest"] == hashlib.sha256(stored_markdown.encode()).hexdigest()


@pytest.mark.parametrize(("observed_text", "verified"), [
    ("Approved copy", True),
    ("Edited after approval", False),
])
def test_x_verification_binds_readback_to_receipted_content(monkeypatch, observed_text, verified):
    posts = []
    approved_text = "Approved copy"
    approved_digest = hashlib.sha256(approved_text.encode()).hexdigest()
    monkeypatch.setattr(stages, "get_job", lambda _job_id: {
        "actions": [{"id": "a1", "type": "publish_x_post", "state": "executed"}],
    })
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [{
        "id": "r1", "actionId": "a1", "detail": {"id": "post-1", "url": "https://x.com/i/web/status/post-1"},
        "artifact": {"kind": "x_api", "digest": approved_digest},
    }])
    monkeypatch.setattr(stages, "get_connection", lambda _platform: {"accessToken": "token"})
    monkeypatch.setattr(stages.x_client, "get_post", lambda _post_id, _token: {"id": "post-1", "text": observed_text})
    monkeypatch.setattr(stages, "current_trace_id", lambda: "a" * 32)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_verify("job-1"))

    result = posts[0][1]["results"][0]
    assert result["verified"] is verified
    assert result["evidence"]["digest"] == hashlib.sha256(observed_text.encode()).hexdigest()
    assert ("matches" in result["note"]) is verified


def test_content_pack_receipt_carries_the_applied_artifact_digest(monkeypatch):
    posts = []
    captured = {}
    analysis = _analysis()
    job = {
        "stage": "publish", "config": {"sourceManifestId": "manifest-1"},
        "sourceAnalysis": analysis, "drafts": [],
        "actions": [{
            "id": "a1", "type": "export_content_pack", "state": "planned",
            "requiresApproval": True, "approvalState": "approved", "payload": {},
        }],
    }
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [_effect_command(job["actions"][0])])
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages, "current_trace_id", lambda: "a" * 32)
    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 1})
    monkeypatch.setattr(stages, "transition_effect_command", lambda _phase, _payload: {})
    def build_pack(title, source, moments, angles, drafts):
        captured.update({"title": title, "source": source, "moments": moments, "angles": angles, "drafts": drafts})
        return "pack"
    monkeypatch.setattr(stages.content, "build_content_pack", build_pack)
    monkeypatch.setattr(stages, "web_post", lambda path, payload: posts.append((path, payload)))

    asyncio.run(stages.run_publish("job-1"))

    receipt = next(payload for path, payload in posts if path == "/api/internal/receipt")
    assert receipt["outcome"] == "applied"
    assert receipt["artifact"]["digest"] == receipt["detail"]["digest"]
    assert len(receipt["artifact"]["digest"]) == 64
    assert receipt["claimToken"]
    assert captured["moments"] == analysis["moments"]
    assert captured["angles"] == analysis["angles"]


def test_paid_media_actions_read_canonical_source_analysis():
    analysis = _analysis()
    analysis["moments"][0]["visualHook"] = "Metric rises on screen"

    actions = stages.deterministic_generative_media_actions({
        "sourceAnalysis": analysis,
    })

    assert [action["type"] for action in actions] == [
        "generate_veo_broll", "generate_lyria_soundtrack",
    ]
    assert actions[0]["momentId"] == "m1"


def test_meme_angles_use_the_canonical_angle_type():
    analysis = _analysis()
    analysis["angles"][0].update(angleType="meme", evidenceKind="public_context")

    assert stages._meme_angles({"sourceAnalysis": analysis}) == analysis["angles"]


def test_publish_never_enters_effect_adapter_without_execute_claim(monkeypatch):
    calls = []
    job = {
        "stage": "publish", "config": {"sourceManifestId": "manifest-1"},
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
    monkeypatch.setattr("harmonia_agent.web_client.claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 1})
    monkeypatch.setattr("harmonia_agent.web_client.transition_effect_command", lambda _phase, _payload: {})
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
    monkeypatch.setattr("harmonia_agent.web_client.claim_effect", lambda _payload: order.append("claim") or {"outcome": "execute", "attempt": 1, "operationEpoch": 1})
    monkeypatch.setattr("harmonia_agent.web_client.transition_effect_command", lambda _phase, _payload: None)
    monkeypatch.setattr("harmonia_agent.web_client.post", lambda _path, _payload: None)
    monkeypatch.setattr(stages, "web_post", lambda _path, _payload: None)
    monkeypatch.setattr(stages, "current_trace_id", lambda: "a" * 32)

    asyncio.run(stages.run_publish("job-1"))

    assert order[:3] == ["connection", "claim", "provider:fresh"]


def test_x_unknown_outcome_enters_the_existing_uncertain_control_path(monkeypatch):
    job = {"stage": "publish", "actions": []}
    command = _effect_command({"id": "a1", "type": "publish_x_post", "payload": {"text": "Approved copy"}})
    monkeypatch.setattr(stages, "get_job", lambda _job_id: job)
    monkeypatch.setattr(stages, "get_effect_commands", lambda _job_id: [command])
    monkeypatch.setattr(stages, "_receipts_for_job", lambda _job_id: [])
    monkeypatch.setattr(stages, "get_connection", lambda _platform: {"accessToken": "fresh"})
    monkeypatch.setattr(stages, "production_adapters", lambda _token: {})
    monkeypatch.setattr(stages, "execute_effect_command", lambda *_args, **_kwargs: ExecutionResult("unknown"))

    with pytest.raises(EffectClaimUncertain, match="no final receipt"):
        asyncio.run(stages.run_publish("job-1"))

def test_uploaded_media_is_materialized_for_clip_rendering(monkeypatch, tmp_path):
    monkeypatch.setattr(stages, "get_chat_attachment", lambda _id: (b"video", "video/mp4", "demo.mp4"))
    monkeypatch.setattr(stages, "get_source", lambda _id: {"payload": {"input": {"kind": "upload", "attachmentId": "attachment-1"}}})
    source = stages._materialize_source_video("job-1", {"sourceSegmentRefs": ["source-1:segment-1"]}, str(tmp_path))
    assert source == Path(tmp_path) / "source.mp4"
    assert source.read_bytes() == b"video"


def test_paid_media_actions_are_deterministic_and_reference_reviewed_evidence_only():
    actions = stages.deterministic_generative_media_actions({
        "sourceAnalysis": {
            "moments": [{
                "id": "m1", "title": "Dashboard reveal", "visualHook": "Metric rises on screen",
                "startSec": 1, "endSec": 8,
            }],
            "angles": [{
                "id": "a1", "angleType": "trend_response", "title": "Speed wins",
                "rationale": "Founders care about activation.",
            }],
        },
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
    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 1})
    monkeypatch.setattr(stages, "transition_effect_command", lambda _phase, _payload: {})
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
    monkeypatch.setattr(stages, "claim_effect", lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 1})
    monkeypatch.setattr(stages, "transition_effect_command", lambda _phase, _payload: {})
    monkeypatch.setattr(stages, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(stages, "get_media_operation", lambda *_args: None)
    monkeypatch.setattr(stages, "get_asset", lambda *_args: None)
    monkeypatch.setattr(stages, "GoogleMediaTransport", lambda **_kwargs: object())
    monkeypatch.setattr(stages.VeoGenerator, "generate", lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError("provider timeout")))
    monkeypatch.setattr(stages, "resolve_budget_reservation", resolutions.append)

    with pytest.raises(TimeoutError, match="provider timeout"):
        asyncio.run(stages.run_publish("job-1"))

    assert resolutions[0]["outcome"] == "uncertain"
