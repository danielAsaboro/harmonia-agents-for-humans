import asyncio

from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import harmonia_agent.telemetry as telemetry
from harmonia_agent import stages
from harmonia_agent.telemetry import (
    configure_telemetry,
    current_trace_id,
    inject_context,
    safe_attributes,
    tracer,
)


def test_w3c_context_round_trip():
    exporter = InMemorySpanExporter()
    configure_telemetry(exporter=exporter, force=True)
    carrier: dict[str, str] = {}
    with tracer().start_as_current_span("harmonia.stage.execute"):
        inject_context(carrier)
        assert len(current_trace_id()) == 32
    assert carrier["traceparent"].startswith("00-")


def test_safe_attributes_drop_content_fields():
    assert safe_attributes({
        "job_id": "j1",
        "model": "m1",
        "prompt": "private",
        "request.body": "private",
        "transcript": "private",
        "response": "private",
    }) == {"job_id": "j1", "model": "m1"}


def test_cloud_exporter_uses_native_otlp_telemetry_endpoint(monkeypatch):
    captured = {}
    marker = object()
    monkeypatch.setattr(telemetry, "_build_channel_credentials", lambda: marker)
    monkeypatch.setattr(
        telemetry,
        "OTLPSpanExporter",
        lambda **kwargs: captured.update(kwargs) or object(),
    )

    telemetry._cloud_exporter()

    assert captured == {
        "credentials": marker,
        "endpoint": "telemetry.googleapis.com:443",
    }


def test_stage_dispatch_creates_a_metadata_only_child_span(monkeypatch):
    exporter = InMemorySpanExporter()
    configure_telemetry(exporter=exporter, force=True)

    async def handler(_job_id: str) -> None:
        return None

    monkeypatch.setitem(stages.HANDLERS, "understand", handler)
    with tracer().start_as_current_span("parent"):
        assert asyncio.run(stages.dispatch("job-1", "understand", attempt=2)) is True

    spans = {span.name: span for span in exporter.get_finished_spans()}
    stage_span = spans["harmonia.stage.execute"]
    assert stage_span.attributes == {
        "job.id": "job-1",
        "stage": "understand",
        "attempt": 2,
    }
    assert all("prompt" not in str(value) for value in stage_span.attributes.values())
