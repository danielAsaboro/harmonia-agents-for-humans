import asyncio
import os
from dataclasses import replace

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


def test_native_resource_reports_aws_region():
    assert telemetry._otel_resource().attributes["cloud.region"] == "us-east-1"
    assert "gcp.project_id" not in telemetry._otel_resource().attributes



def test_native_telemetry_never_captures_message_content():
    telemetry._privacy_environment()
    assert os.environ["STRANDS_OTEL_CAPTURE_CONTENT"] == "false"
    assert os.environ["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] == "NO_CONTENT"



def test_native_telemetry_applies_configured_parent_based_sampling(monkeypatch):
    configured = replace(telemetry.settings(), telemetry_sample_rate=.25)
    monkeypatch.setattr(telemetry, "settings", lambda: configured)
    provider = configure_telemetry(exporter=InMemorySpanExporter(), force=True)
    assert provider.sampler.get_description() == "ParentBased{root:TraceIdRatioBased{0.25},remoteParentSampled:AlwaysOnSampler,remoteParentNotSampled:AlwaysOffSampler,localParentSampled:AlwaysOnSampler,localParentNotSampled:AlwaysOffSampler}"



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
        "optional": None,
    }) == {"job_id": "j1", "model": "m1"}


def test_cloud_exporter_requires_explicit_native_otlp_endpoint(monkeypatch):
    import pytest
    configured = replace(telemetry.settings(), telemetry_enabled=True)
    monkeypatch.setattr(telemetry, "settings", lambda: configured)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    with pytest.raises(ValueError, match="OTEL_EXPORTER_OTLP_ENDPOINT"):
        configure_telemetry(force=True)



def test_stage_dispatch_creates_a_metadata_only_child_span(monkeypatch):
    exporter = InMemorySpanExporter()
    configure_telemetry(exporter=exporter, force=True)

    async def handler(_job_id: str) -> None:
        return None

    monkeypatch.setitem(stages.HANDLERS, "understand", handler)
    monkeypatch.setattr(stages, "get_job", lambda _job_id: {"controlState": "running"})
    monkeypatch.setattr(stages, "claim_stage_execution", lambda _payload: {"outcome": "execute"})
    monkeypatch.setattr(stages, "finalize_stage_execution", lambda _payload: None)
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
