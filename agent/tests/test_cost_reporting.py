from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from harmonia_agent import content
from harmonia_agent.agent_models import AnalystInput, ContentDraft, EditorialReviewInput, MediaEvidence
from harmonia_agent.agents import _run_coordinator
from harmonia_agent.agents import RoleModelInstances
from harmonia_agent.gemma_model import VertexGemmaModel
from harmonia_agent.role_models import RoleModelConfig
from harmonia_agent.usage import InvocationContext, run_metered
from harmonia_agent.telemetry import configure_telemetry
from test_agent_team import ManagedRuntime, ScriptedDraftModel, _analysis, _production_input
from harmonia_agent.tenant_context import tenant_scope
from tests.test_ryan_strategy import strategy as _content_strategy


def _analyst_input(*, media: bool = False) -> AnalystInput:
    digest = "a" * 64
    return AnalystInput.model_validate({
        "sourceId": "source-1", "sourceKind": "media" if media else "brief",
        "sourceDigest": digest, "title": "Demo", "channel": "test",
        "transcriptSegments": [{"id": "segment-1", "startSec": 0, "endSec": 30,
                                "text": "proof We cut nine days to forty hours."}],
        "mediaEvidence": ({"video_uri": "https://www.youtube.com/watch?v=abc12345678", "duration_sec": 60,
                           "source_digest": digest, "frames": []} if media else None),
        "performanceObservations": [], "memoryFacts": [],
    })


def test_model_call_reserves_budget_before_provider():
    order: list[str] = []

    def reserve(payload):
        assert payload["operationId"] == "j1:draft:nimi:0"
        order.append("reserve")

    async def invoke():
        order.append("model")
        return "validated-result", {"id": "usage-1"}

    def finalize(payload):
        assert payload == {"id": "usage-1"}
        order.append("usage")

    result = asyncio.run(run_metered(
        reservation={"operationId": "j1:draft:nimi:0"},
        reserve=reserve,
        invoke=invoke,
        finalize=finalize,
    ))

    assert result == "validated-result"
    assert order == ["reserve", "model", "usage"]


def test_draft_run_reserves_and_reports_each_participating_role():
    reservations: list[dict] = []
    reports: list[dict] = []
    model = ScriptedDraftModel(model="gemini-3.5-flash")
    payload = _production_input()

    state = asyncio.run(_run_coordinator(
        "noni_copywriter",
        payload,
        model=model,
        team_runtime=ManagedRuntime(),
        invocation=InvocationContext(
            workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
            job_id="job-1", stage="draft", operation_id="job-1:draft:0",
        ),
        budget_reserver=reservations.append,
        usage_reporter=reports.append,
    ))
    draft = ContentDraft.model_validate(state["copywriter_draft"])
    asyncio.run(_run_coordinator(
        "dara_editor", EditorialReviewInput(copywriterInput=payload, draft=draft),
        model=model, team_runtime=ManagedRuntime(),
        invocation=InvocationContext(workspace_id="workspace-test", brand_id="brand-test", user_id="user-test", job_id="job-1", stage="draft", operation_id="job-1:draft:0:dara"),
        budget_reserver=reservations.append, usage_reporter=reports.append,
    ))

    assert [item["role"] for item in reservations] == [
        "harmonia_coordinator", "noni_copywriter", "harmonia_coordinator", "dara_editor",
    ]
    assert [item["role"] for item in reports] == [
        "harmonia_coordinator", "noni_copywriter", "harmonia_coordinator", "dara_editor",
    ]
    trace_ids = {item["traceId"] for item in reports}
    assert len(trace_ids) == 2
    assert "0" * 32 not in trace_ids


def test_managed_agent_run_projects_log_trace_and_metric_activity():
    activity = []
    invocation = InvocationContext(
        workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
        job_id="job-1", stage="understand", operation_id="job-1:understand:0",
    )
    asyncio.run(_run_coordinator(
        "nimi_analyst", _analyst_input(), model="gemini-3.5-flash",
        team_runtime=ManagedRuntime(), invocation=invocation,
        budget_reserver=lambda _item: None, usage_reporter=lambda _item: None,
        activity_reporter=activity.append,
    ))

    assert {item.signalType for item in activity} == {"log", "trace", "metric"}
    assert all(item.agent == "nimi_analyst" for item in activity)
    assert all(item.workspaceId == "workspace-test" for item in activity)
    assert all(item.outcome == "success" for item in activity)


def test_team_releases_prior_reservations_when_reservation_fails_before_dispatch():
    resolutions: list[dict] = []
    calls = 0

    def reserve(_payload):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("budget service unavailable")

    with pytest.raises(RuntimeError, match="budget service unavailable"):
        asyncio.run(_run_coordinator(
            "noni_copywriter",
            _production_input(),
            model=ScriptedDraftModel(model="gemini-3.5-flash"),
            team_runtime=ManagedRuntime(),
            invocation=InvocationContext(
                workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
                job_id="job-1", stage="draft", operation_id="job-1:draft:0",
            ),
            budget_reserver=reserve,
            budget_resolver=resolutions.append,
        ))

    assert len(resolutions) == 1
    assert resolutions[0]["operationId"] == "job-1:draft:0:harmonia_coordinator"
    assert resolutions[0]["outcome"] == "not_invoked"


def test_team_quarantines_all_reservations_when_runtime_fails_after_dispatch():
    class FailingRuntime:
        async def invoke(self, **_kwargs):
            raise TimeoutError("managed runtime timeout")

    resolutions: list[dict] = []
    with pytest.raises(TimeoutError, match="managed runtime timeout"):
        asyncio.run(_run_coordinator(
            "nimi_analyst",
            _analyst_input(),
            model="gemini-3.5-flash",
            team_runtime=FailingRuntime(),
            invocation=InvocationContext(
                workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
                job_id="job-1", stage="understand", operation_id="job-1:understand:0",
            ),
            budget_reserver=lambda _payload: None,
            budget_resolver=resolutions.append,
        ))

    assert [item["operationId"] for item in resolutions] == [
        "job-1:understand:0:harmonia_coordinator",
        "job-1:understand:0:nimi_analyst",
    ]
    assert {item["outcome"] for item in resolutions} == {"uncertain"}


def test_transcription_reserves_before_provider_and_reports_tokens(monkeypatch):
    order: list[str] = []
    reservations: list[dict] = []
    reports: list[dict] = []

    class Models:
        def generate_content(self, **_kwargs):
            assert order == ["reserve"]
            order.append("provider")
            return SimpleNamespace(
                text='{"language":"en","segments":[{"id":"s1","startSec":0,"endSec":1,"text":"hello"}]}',
                usage_metadata=SimpleNamespace(
                    prompt_token_count=120, candidates_token_count=30,
                ),
            )

    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.setattr(content, "_client", lambda: SimpleNamespace(models=Models()))

    result = content.transcribe_audio(
        b"audio", "audio/mp4",
        invocation=InvocationContext(
            workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
            job_id="job-1", stage="transcribe", operation_id="job-1:transcribe:0",
        ),
        budget_reserver=lambda item: (reservations.append(item), order.append("reserve")),
        usage_reporter=lambda item: (reports.append(item), order.append("usage")),
    )

    assert result["segments"][0]["text"] == "hello"
    assert order == ["reserve", "provider", "usage"]
    assert reservations[0]["role"] == "transcriber"
    assert reports[0]["inputUnits"] == 120
    assert reports[0]["outputUnits"] == 30


def test_transcription_releases_when_client_fails_before_dispatch(monkeypatch):
    resolutions: list[dict] = []
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.setattr(content, "_client", lambda: (_ for _ in ()).throw(RuntimeError("client unavailable")))

    with pytest.raises(RuntimeError):
        content.transcribe_audio(
            b"audio", "audio/mp4",
            invocation=InvocationContext(
                workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
                job_id="job-1", stage="transcribe", operation_id="job-1:transcribe:0",
            ),
            budget_reserver=lambda _item: None,
            budget_resolver=resolutions.append,
        )

    assert resolutions[0]["outcome"] == "not_invoked"


def test_transcription_quarantines_timeout_after_dispatch(monkeypatch):
    resolutions: list[dict] = []

    class Models:
        def generate_content(self, **_kwargs):
            raise TimeoutError("timeout")

    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.setattr(content, "_client", lambda: SimpleNamespace(models=Models()))
    with pytest.raises(TimeoutError):
        content.transcribe_audio(
            b"audio", "audio/mp4",
            invocation=InvocationContext(
                workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
                job_id="job-1", stage="transcribe", operation_id="job-1:transcribe:0",
            ),
            budget_reserver=lambda _item: None,
            budget_resolver=resolutions.append,
        )

    assert resolutions[0]["outcome"] == "uncertain"


def test_image_generation_uses_explicit_maximum_cost_reservation(monkeypatch):
    reservations: list[dict] = []
    reports: list[dict] = []
    image = SimpleNamespace(image_bytes=b"png", mime_type="image/png")
    response = SimpleNamespace(generated_images=[SimpleNamespace(image=image)])
    models = SimpleNamespace(generate_images=lambda **_kwargs: response)
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.setattr(content, "_client", lambda: SimpleNamespace(models=models))

    generated, mime = content.generate_image(
        "safe visual description",
        invocation=InvocationContext(
            workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
            job_id="job-1", stage="publish", operation_id="job-1:publish:act-img",
        ),
        budget_reserver=reservations.append,
        usage_reporter=reports.append,
    )

    assert generated == b"png" and mime == "image/png"
    assert reservations[0]["estimatedCostUsd"] == "0.500000"
    assert reports[0]["unitType"] == "images"
    assert reports[0]["inputUnits"] == 1


def test_image_generation_releases_reservation_when_client_fails_before_dispatch(monkeypatch):
    resolutions: list[dict] = []
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    monkeypatch.setattr(content, "_client", lambda: (_ for _ in ()).throw(RuntimeError("client unavailable")))

    with pytest.raises(content.ImageGenError):
        content.generate_image(
            "safe visual description",
            invocation=InvocationContext(
                workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
                job_id="job-1", stage="publish", operation_id="job-1:publish:act-img",
            ),
            budget_reserver=lambda _item: None,
            budget_resolver=resolutions.append,
        )

    assert resolutions[0]["outcome"] == "not_invoked"


def test_image_generation_marks_reservation_uncertain_after_provider_dispatch(monkeypatch):
    resolutions: list[dict] = []
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    models = SimpleNamespace(generate_images=lambda **_kwargs: (_ for _ in ()).throw(TimeoutError("timeout")))
    monkeypatch.setattr(content, "_client", lambda: SimpleNamespace(models=models))

    with pytest.raises(content.ImageGenError):
        content.generate_image(
            "safe visual description",
            invocation=InvocationContext(
                workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
                job_id="job-1", stage="publish", operation_id="job-1:publish:act-img",
            ),
            budget_reserver=lambda _item: None,
            budget_resolver=resolutions.append,
        )

    assert resolutions[0]["outcome"] == "uncertain"


def test_image_generation_marks_empty_provider_response_uncertain(monkeypatch):
    resolutions: list[dict] = []
    monkeypatch.delenv("HARMONIA_MOCK_AI", raising=False)
    models = SimpleNamespace(generate_images=lambda **_kwargs: SimpleNamespace(generated_images=[]))
    monkeypatch.setattr(content, "_client", lambda: SimpleNamespace(models=models))

    with pytest.raises(content.ImageGenError):
        content.generate_image(
            "safe visual description",
            invocation=InvocationContext(
                workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
                job_id="job-1", stage="publish", operation_id="job-1:publish:act-img",
            ),
            budget_reserver=lambda _item: None,
            budget_resolver=resolutions.append,
        )

    assert resolutions[0]["outcome"] == "uncertain"


def test_agent_trace_has_safe_delegation_model_and_validation_spans():
    exporter = InMemorySpanExporter()
    configure_telemetry(exporter=exporter, force=True)
    payload = _production_input().model_copy(update={"brandContext": "private voice instructions"})

    asyncio.run(_run_coordinator(
        "noni_copywriter",
        payload,
        model=ScriptedDraftModel(model="gemini-3.5-flash"),
        team_runtime=ManagedRuntime(),
        invocation=InvocationContext(
            workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
            job_id="job-1", stage="draft", operation_id="job-1:draft:0",
        ),
        budget_reserver=lambda _item: None,
        usage_reporter=lambda _item: None,
    ))

    spans = exporter.get_finished_spans()
    names = [span.name for span in spans]
    assert "harmonia.agent.invoke" in names
    assert "harmonia.output.validate" in names
    invoke = next(span for span in spans if span.name == "harmonia.agent.invoke")
    assert any(event.name == "harmonia.agent.delegate" for event in invoke.events)
    serialized = " ".join(
        [span.name for span in spans]
        + [str(span.attributes) for span in spans]
        + [str(event.attributes) for span in spans for event in span.events]
    )
    assert "private voice instructions" not in serialized
    assert "Original" not in serialized
    assert "Reviewed" not in serialized


def test_heterogeneous_draft_usage_keeps_each_actual_role_model():
    reservations: list[dict] = []
    reports: list[dict] = []

    async def gemma_predict(_endpoint, _instances, _parameters):
        return {"predictions": [{
            "content": '{"drafts":[{"id":"d1","platform":"x","momentId":"m1","text":"Original"}]}',
        }]}

    models = RoleModelInstances(
        coordinator=ScriptedDraftModel(model="gemini-3.5-flash-lite"),
        strategist=ScriptedDraftModel(model="gemini-3.5-flash"),
        analyst=ScriptedDraftModel(model="gemini-3.5-flash"),
        copywriter=VertexGemmaModel(
            model="gemma-3-12b-it",
            endpoint="projects/p/locations/us-central1/endpoints/1",
            predict=gemma_predict,
        ),
        editor=ScriptedDraftModel(model="gemini-3.5-flash"),
        planner=ScriptedDraftModel(model="gemini-3.5-flash-lite"),
        presenter=ScriptedDraftModel(model="gemini-3.5-flash"),
        liaison=ScriptedDraftModel(model="gemini-3.5-flash"),
        configs={
            "noni_copywriter": RoleModelConfig(
                role="noni_copywriter",
                provider="vertex_endpoint",
                model_id="gemma-3-12b-it",
                endpoint="projects/p/locations/us-central1/endpoints/1",
                max_output_tokens=2048,
                reservation_usd="0.100000",
            ),
        },
    )

    state = asyncio.run(_run_coordinator(
        "noni_copywriter",
        _production_input(),
        models=models,
        team_runtime=ManagedRuntime(),
        invocation=InvocationContext(
            workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
            job_id="job-1", stage="draft", operation_id="job-1:draft:0",
        ),
        budget_reserver=reservations.append,
        usage_reporter=reports.append,
    ))
    draft = ContentDraft.model_validate(state["copywriter_draft"])
    asyncio.run(_run_coordinator(
        "dara_editor", EditorialReviewInput(copywriterInput=_production_input(), draft=draft),
        models=models, team_runtime=ManagedRuntime(),
        invocation=InvocationContext(workspace_id="workspace-test", brand_id="brand-test", user_id="user-test", job_id="job-1", stage="draft", operation_id="job-1:draft:0:dara"),
        budget_reserver=reservations.append, usage_reporter=reports.append,
    ))

    expected = {"harmonia_coordinator": "gemini-3.5-flash-lite", "noni_copywriter": "gemma-3-12b-it", "dara_editor": "gemini-3.5-flash"}
    assert {item["role"]: item["model"] for item in reservations} == expected
    assert {item["role"]: item["model"] for item in reports} == expected
    gemma_usage = next(item for item in reports if item["role"] == "noni_copywriter")
    assert gemma_usage["unitType"] == "endpoint_seconds"
    assert gemma_usage["estimatedCostUsd"] == "0.100000"


def test_multimodal_source_uri_is_not_exported_in_trace_content():
    exporter = InMemorySpanExporter()
    configure_telemetry(exporter=exporter, force=True)
    source = "https://www.youtube.com/watch?v=abc12345678"

    with tenant_scope("workspace-test", "brand-test"):
        asyncio.run(_run_coordinator(
            "nimi_analyst",
            _analyst_input(media=True),
            model="gemini-test",
            team_runtime=ManagedRuntime(),
        ))

    serialized = " ".join(
        [str(span.attributes) for span in exporter.get_finished_spans()]
        + [
            str(event.attributes)
            for span in exporter.get_finished_spans()
            for event in span.events
        ]
    )
    assert source not in serialized


def test_managed_runtime_finalizes_explicit_estimated_usage_for_every_reserved_role():
    class ManagedRuntime:
        async def invoke(self, **_kwargs):
            return {
                "source_analysis": {
                    "sourceDigest": "a" * 64, "summary": "managed",
                    "moments": [{"id": "m1", "title": "proof", "startSec": 0, "endSec": 1,
                                 "hook": "proof", "quote": "proof", "transcriptSegmentRefs": ["segment-1"],
                                 "visualEvidenceIds": [], "assumptions": [], "confidence": "high"}],
                    "angles": [], "assumptions": [], "confidence": "high",
                },
            }

    reservations: list[dict] = []
    reports: list[dict] = []
    asyncio.run(_run_coordinator(
        "nimi_analyst",
        _analyst_input(),
        model="gemini-3.5-flash",
        invocation=InvocationContext(
            workspace_id="workspace-test", brand_id="brand-test", user_id="user-test",
            job_id="job-1", stage="understand", operation_id="job-1:understand:0",
        ),
        team_runtime=ManagedRuntime(),
        budget_reserver=reservations.append,
        usage_reporter=reports.append,
    ))

    assert [item["role"] for item in reports] == [
        "harmonia_coordinator", "nimi_analyst",
    ]
    assert all(item["unitType"] == "tokens" for item in reports)
    assert all(item.get("observedCostUsd") is None for item in reports)
