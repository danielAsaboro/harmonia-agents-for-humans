from types import SimpleNamespace

from harmonia_agent.usage import UsageAccumulator, estimate_request_tokens


def test_estimate_request_tokens_is_deterministic():
    assert estimate_request_tokens('{"brief":"12345678"}', 200) == (5, 200)


def test_accumulator_sums_adk_usage_metadata():
    accumulator = UsageAccumulator(
        job_id="j1",
        operation_id="j1:draft:nimi:0",
        stage="draft",
        role="nimi",
        model="gemini-3.5-flash",
    )
    accumulator.observe_event(SimpleNamespace(usage_metadata=SimpleNamespace(
        prompt_token_count=120,
        candidates_token_count=30,
    )))
    accumulator.observe_event(SimpleNamespace(usage_metadata=SimpleNamespace(
        prompt_token_count=10,
        candidates_token_count=5,
    )))
    record = accumulator.finalize(trace_id="0" * 32)
    assert record.input_units == 130
    assert record.output_units == 35
    assert record.estimated_cost_usd == "0.000510"
    assert record.operation_id == "j1:draft:nimi:0"
