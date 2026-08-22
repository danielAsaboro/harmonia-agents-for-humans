from __future__ import annotations

import asyncio
from types import SimpleNamespace

from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from harmonia_agent import content
from harmonia_agent.agent_models import DraftWorkflowInput
from harmonia_agent.agents import _run_coordinator
from harmonia_agent.usage import InvocationContext, run_metered
from harmonia_agent.telemetry import configure_telemetry
from test_agent_team import ScriptedDraftModel, _analysis


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
    payload = DraftWorkflowInput(title="Demo", analysis=_analysis(), brand_context="voice: direct")

    asyncio.run(_run_coordinator(
        "flo_draft_workflow",
        payload,
        model=model,
        invocation=InvocationContext(
            job_id="job-1", stage="draft", operation_id="job-1:draft:0",
        ),
        budget_reserver=reservations.append,
        usage_reporter=reports.append,
    ))

    assert [item["role"] for item in reservations] == [
        "harmonia_coordinator", "nimi_copywriter", "dara_editor", "temi_planner",
    ]
    assert [item["role"] for item in reports] == [
        "harmonia_coordinator", "nimi_copywriter", "dara_editor", "temi_planner",
    ]
    trace_ids = {item["traceId"] for item in reports}
    assert len(trace_ids) == 1
    assert next(iter(trace_ids)) != "0" * 32


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
            job_id="job-1", stage="publish", operation_id="job-1:publish:act-img",
        ),
        budget_reserver=reservations.append,
        usage_reporter=reports.append,
    )

    assert generated == b"png" and mime == "image/png"
    assert reservations[0]["estimatedCostUsd"] == "0.500000"
    assert reports[0]["unitType"] == "images"
    assert reports[0]["inputUnits"] == 1


def test_agent_trace_has_safe_delegation_model_and_validation_spans():
    exporter = InMemorySpanExporter()
    configure_telemetry(exporter=exporter, force=True)
    payload = DraftWorkflowInput(
        title="Demo", analysis=_analysis(), brand_context="private voice instructions",
    )

    asyncio.run(_run_coordinator(
        "flo_draft_workflow",
        payload,
        model=ScriptedDraftModel(model="gemini-3.5-flash"),
        invocation=InvocationContext(
            job_id="job-1", stage="draft", operation_id="job-1:draft:0",
        ),
        budget_reserver=lambda _item: None,
        usage_reporter=lambda _item: None,
    ))

    spans = exporter.get_finished_spans()
    names = [span.name for span in spans]
    assert "harmonia.agent.invoke" in names
    assert "harmonia.model.generate" in names
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
