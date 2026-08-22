from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

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
