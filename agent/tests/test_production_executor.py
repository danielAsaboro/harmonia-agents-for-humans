"""The paid media executor is isolated from publication and bound to sealed claims."""

from __future__ import annotations

from types import SimpleNamespace

from harmonia_agent import production_executor
from harmonia_agent.generative_media import GeneratedMedia, MediaOperationPending, MediaProviderError
from harmonia_agent.web_client import WebApiError


def _operation() -> dict:
    return {
        "id": "plan-1:generate_video:scene-1",
        "jobId": "job-1",
        "type": "generate_video",
        "dependsOn": [],
        "payload": {
            "modelCapability": "veo-3.1-fast",
            "mode": "text_to_video",
            "prompt": "calm blue network",
            "durationSec": 4,
            "aspectRatio": "9:16",
            "resolution": "1080p",
            "generateAudio": False,
            "enhancePrompt": True,
            "outputCount": 1,
        },
        "requestDigest": "a" * 64,
        "estimatedCostUsd": "0.320000",
        "executionAuthority": "production_mandate",
    }


def _claim(*, provider_operation_id: str | None = None) -> dict:
    claim = {
        "id": "claim-1",
        "planId": "plan-1",
        "jobId": "job-1",
        "workspaceId": "workspace-1",
        "brandId": "brand-1",
        "pricingVersion": "2026-08-31",
        "operationId": _operation()["id"],
        "reservedCostUsd": "0.320000",
        "state": "claimed",
    }
    if provider_operation_id:
        claim.update(provider="veo", providerOperationId=provider_operation_id)
    return {"outcome": "execute", "claim": claim, "operation": _operation()}


def test_executor_claims_sealed_operation_before_provider_and_uploads_verified_bytes(monkeypatch):
    order: list[str] = []
    provider_records: list[dict] = []
    uploads: list[dict] = []
    inspected: list[tuple[bytes, str]] = []

    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: order.append("claim") or _claim())
    monkeypatch.setattr(production_executor, "settings", lambda: SimpleNamespace(gcp_project="project-1", vertex_media_location="us-central1"))
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: object())

    def generate(_self, *, request, existing_operation, persist_operation):
        assert order == ["claim", "budget:0.320000", "submission"]
        assert existing_operation is None
        persist_operation("projects/p/locations/us-central1/operations/veo-1")
        return GeneratedMedia(
            data=b"real-video-bytes",
            mime="video/mp4",
            model="veo-3.1-fast-generate-001",
            provider_id="projects/p/locations/us-central1/operations/veo-1",
            duration_sec=4,
            estimated_cost_usd="999.000000",
        )

    monkeypatch.setattr(production_executor.VeoGenerator, "generate", generate)
    monkeypatch.setattr(production_executor, "record_production_provider_operation", lambda *args, **kwargs: provider_records.append(kwargs))
    monkeypatch.setattr(production_executor, "upload_production_artifact", lambda *args, **kwargs: uploads.append(kwargs) or {"state": "succeeded"})
    monkeypatch.setattr(production_executor, "reserve_budget", lambda payload: order.append(f"budget:{payload['estimatedCostUsd']}") or None)
    monkeypatch.setattr(production_executor, "report_usage", lambda _payload: None)
    monkeypatch.setattr(production_executor, "inspect_generated_media_bytes", lambda data, mime: inspected.append((data, mime)) or {"durationSec": 4.0, "video": {"codec": "h264"}})
    monkeypatch.setattr(production_executor, "start_production_provider_submission", lambda *_args, **_kwargs: order.append("submission"))

    result = production_executor.execute_paid_production_operation("plan-1", _operation()["id"], claim_token="worker-1")

    assert result["outcome"] == "succeeded"
    assert order[:3] == ["claim", "budget:0.320000", "submission"]
    assert provider_records[0]["provider_operation_id"].endswith("veo-1")
    assert uploads[0]["data"] == b"real-video-bytes"
    assert uploads[0]["provider_metadata"]["estimatedCostUsd"] == "0.320000"
    assert uploads[0]["provider_metadata"]["inspection"]["video"]["codec"] == "h264"
    assert inspected == [(b"real-video-bytes", "video/mp4")]


def test_executor_resumes_persisted_veo_identity_without_duplicate_submission(monkeypatch):
    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: _claim(provider_operation_id="operations/existing"))
    monkeypatch.setattr(production_executor, "settings", lambda: SimpleNamespace(gcp_project="project-1", vertex_media_location="us-central1"))
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: object())
    monkeypatch.setattr(production_executor, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(production_executor, "start_production_provider_submission", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("resume must not start a new submission")))

    def pending(_self, *, existing_operation, persist_operation, **_kwargs):
        assert existing_operation == "operations/existing"
        persist_operation("operations/existing")
        raise MediaOperationPending("operations/existing")

    monkeypatch.setattr(production_executor.VeoGenerator, "generate", pending)
    monkeypatch.setattr(production_executor, "record_production_provider_operation", lambda *_args, **_kwargs: None)

    result = production_executor.execute_paid_production_operation("plan-1", _operation()["id"], claim_token="worker-2")

    assert result == {"outcome": "waiting_provider", "providerOperationId": "operations/existing"}


def test_executor_returns_terminal_duplicate_without_invoking_provider(monkeypatch):
    duplicate = _claim()
    duplicate["outcome"] = "already_succeeded"
    duplicate["claim"].update(state="succeeded", artifact={"digest": "b" * 64})
    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: duplicate)
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("provider must not run")))

    result = production_executor.execute_paid_production_operation("plan-1", _operation()["id"], claim_token="worker-3")

    assert result == {"outcome": "already_succeeded", "artifact": {"digest": "b" * 64}}


def test_executor_quarantines_ambiguous_provider_failure_without_resubmission(monkeypatch):
    failures: list[dict] = []
    resolutions: list[dict] = []
    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: _claim())
    monkeypatch.setattr(production_executor, "settings", lambda: SimpleNamespace(gcp_project="project-1", vertex_media_location="us-central1"))
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: object())
    monkeypatch.setattr(production_executor, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(production_executor, "start_production_provider_submission", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(production_executor.VeoGenerator, "generate", lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError("provider timeout")))
    monkeypatch.setattr(production_executor, "record_production_operation_failure", lambda *args, **kwargs: failures.append(kwargs))
    monkeypatch.setattr(production_executor, "resolve_budget_reservation", resolutions.append)

    try:
        production_executor.execute_paid_production_operation("plan-1", _operation()["id"], claim_token="worker-4")
    except TimeoutError as exc:
        assert str(exc) == "provider timeout"
    else:
        raise AssertionError("provider timeout must remain visible")

    assert failures == [{
        "claim_id": "claim-1",
        "claim_token": "worker-4",
        "outcome": "uncertain",
        "reason": "TimeoutError: provider timeout",
    }]
    assert resolutions[0]["outcome"] == "uncertain"


def test_executor_requeues_transient_veo_poll_failure_after_provider_identity_is_durable(monkeypatch):
    provider_records: list[dict] = []
    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: _claim())
    monkeypatch.setattr(production_executor, "settings", lambda: SimpleNamespace(gcp_project="project-1", vertex_media_location="us-central1"))
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: object())
    monkeypatch.setattr(production_executor, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(production_executor, "start_production_provider_submission", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(production_executor, "record_production_provider_operation", lambda *args, **kwargs: provider_records.append(kwargs))
    monkeypatch.setattr(production_executor, "record_production_operation_failure", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("resumable poll must not be failed")))

    def transient_poll(_self, *, persist_operation, **_kwargs):
        persist_operation("operations/veo-durable")
        raise MediaProviderError("HTTP 503")

    monkeypatch.setattr(production_executor.VeoGenerator, "generate", transient_poll)

    result = production_executor.execute_paid_production_operation(
        "plan-1", _operation()["id"], claim_token="worker-transient",
    )

    assert result == {"outcome": "waiting_provider", "providerOperationId": "operations/veo-durable"}
    assert len(provider_records) == 2


def test_executor_persists_budget_rejection_as_terminal_failure_before_provider(monkeypatch):
    failures: list[dict] = []
    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: _claim())
    monkeypatch.setattr(production_executor, "reserve_budget", lambda _payload: (_ for _ in ()).throw(WebApiError("budget rejected", 409)))
    monkeypatch.setattr(production_executor, "record_production_operation_failure", lambda *args, **kwargs: failures.append(kwargs) or {"state": "failed"})
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("provider must not run")))

    result = production_executor.execute_paid_production_operation(
        "plan-1", _operation()["id"], claim_token="worker-budget-rejected",
    )

    assert result == {"outcome": "failed", "reason": "budget authorization rejected"}
    assert failures == [{
        "claim_id": "claim-1",
        "claim_token": "worker-budget-rejected",
        "outcome": "failed",
        "reason": "budget authorization rejected: WebApiError",
    }]


def test_executor_releases_budget_when_predispatch_authorization_is_revoked(monkeypatch):
    failures: list[dict] = []
    resolutions: list[dict] = []
    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: _claim())
    monkeypatch.setattr(production_executor, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(production_executor, "start_production_provider_submission", lambda *_args, **_kwargs: (_ for _ in ()).throw(WebApiError("revision superseded", 409)))
    monkeypatch.setattr(production_executor, "record_production_operation_failure", lambda *args, **kwargs: failures.append(kwargs) or {"state": "failed"})
    monkeypatch.setattr(production_executor, "resolve_budget_reservation", resolutions.append)
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: (_ for _ in ()).throw(AssertionError("provider must not run")))

    result = production_executor.execute_paid_production_operation(
        "plan-1", _operation()["id"], claim_token="worker-revoked",
    )

    assert result == {"outcome": "failed", "reason": "provider submission authorization failed"}
    assert failures[0]["outcome"] == "failed"
    assert resolutions == [{
        "jobId": "job-1",
        "operationId": "production:claim-1",
        "outcome": "not_invoked",
        "reason": "provider submission authorization failed before provider invocation",
    }]


def test_executor_surfaces_failed_veo_poll_rearm_for_pubsub_retry(monkeypatch):
    monkeypatch.setattr(production_executor, "claim_production_operation", lambda *_args: _claim(provider_operation_id="operations/existing"))
    monkeypatch.setattr(production_executor, "settings", lambda: SimpleNamespace(gcp_project="project-1", vertex_media_location="us-central1"))
    monkeypatch.setattr(production_executor, "GoogleMediaTransport", lambda **_kwargs: object())
    monkeypatch.setattr(production_executor, "reserve_budget", lambda _payload: None)
    monkeypatch.setattr(production_executor.VeoGenerator, "generate", lambda *_args, **_kwargs: (_ for _ in ()).throw(MediaProviderError("poll unavailable")))
    monkeypatch.setattr(production_executor, "record_production_provider_operation", lambda *_args, **_kwargs: (_ for _ in ()).throw(WebApiError("re-arm unavailable", 503)))
    monkeypatch.setattr(production_executor, "record_production_operation_failure", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("transient persisted poll must not be terminal")))

    try:
        production_executor.execute_paid_production_operation(
            "plan-1", _operation()["id"], claim_token="worker-rearm-failure",
        )
    except WebApiError as exc:
        assert exc.status == 503
    else:
        raise AssertionError("failed durable re-arm must remain retryable")
