import pytest

from harmonia_agent.effect_executor import ProviderEffectNotStarted, execute_effect_command


def _command():
    return {
        "id": "command-1", "jobId": "job-1", "actionId": "action-1",
        "actionType": "publish_x_post", "payload": {"text": "Launch"},
        "payloadDigest": "a" * 64,
    }


def test_non_execute_claim_never_enters_provider():
    for outcome in ("in_progress", "already_applied", "uncertain", "paused", "cancelled"):
        calls = []
        result = execute_effect_command(
            _command(), adapters={"publish_x_post": lambda _payload: calls.append("provider")},
            claim=lambda _payload, outcome=outcome: {"outcome": outcome, "receiptId": "r1"},
            transition=lambda _phase, _payload: None,
            finalize=lambda _payload: calls.append("finalize"), trace_id="b" * 32, claim_token="owner-1",
        )
        assert calls == []
        assert result.outcome == outcome


def test_execute_claim_uses_command_payload_and_finalizes_once():
    calls = []
    result = execute_effect_command(
        _command(),
        adapters={"publish_x_post": lambda payload: calls.append(payload) or {"outcome": "applied", "detail": {"id": "post-1"}}},
        claim=lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 1},
        transition=lambda _phase, _payload: None,
        finalize=lambda payload: calls.append(payload), trace_id="b" * 32, claim_token="owner-1",
    )
    assert calls[0] == {"text": "Launch"}
    assert calls[1]["commandId"] == "command-1"
    assert result.outcome == "applied"


def test_dispatch_is_persisted_before_provider_and_observation_before_receipt():
    calls = []
    execute_effect_command(
        _command(),
        adapters={"publish_x_post": lambda payload: calls.append(("provider", payload)) or {"outcome": "applied", "detail": {"id": "post-1"}}},
        claim=lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 4},
        transition=lambda phase, payload: calls.append((phase, payload)),
        finalize=lambda payload: calls.append(("receipt", payload)),
        trace_id="b" * 32, claim_token="owner-1",
    )
    assert [entry[0] for entry in calls] == ["dispatched", "provider", "observed", "receipt"]
    assert calls[0][1]["operationEpoch"] == 4
    assert calls[2][1]["outcome"] == "applied"


def test_typed_not_started_failure_restores_retry_without_claiming_provider_entry():
    calls = []
    with pytest.raises(ProviderEffectNotStarted):
        execute_effect_command(
            _command(),
            adapters={"publish_x_post": lambda _payload: (_ for _ in ()).throw(ProviderEffectNotStarted("socket never opened"))},
            claim=lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 2},
            transition=lambda phase, payload: calls.append((phase, payload)),
            finalize=lambda payload: calls.append(("receipt", payload)),
            trace_id="b" * 32, claim_token="owner-1",
        )
    assert [entry[0] for entry in calls] == ["dispatched", "provider_not_started"]


def test_ordinary_post_dispatch_failure_becomes_unknown_and_is_never_finalized_failed():
    calls = []
    result = execute_effect_command(
        _command(),
        adapters={"publish_x_post": lambda _payload: (_ for _ in ()).throw(TimeoutError("response lost"))},
        claim=lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 2},
        transition=lambda phase, payload: calls.append((phase, payload)),
        finalize=lambda payload: calls.append(("receipt", payload)),
        trace_id="b" * 32, claim_token="owner-1",
    )
    assert result.outcome == "unknown"
    assert [entry[0] for entry in calls] == ["dispatched", "unknown"]
    assert "TimeoutError" in calls[1][1]["reason"]


def test_receipt_commit_failure_after_durable_observation_remains_observed_for_recovery():
    calls = []
    with pytest.raises(RuntimeError, match="receipt store unavailable"):
        execute_effect_command(
            _command(),
            adapters={"publish_x_post": lambda _payload: {"outcome": "applied", "detail": {"id": "post-1"}}},
            claim=lambda _payload: {"outcome": "execute", "attempt": 1, "operationEpoch": 2},
            transition=lambda phase, payload: calls.append((phase, payload)),
            finalize=lambda _payload: (_ for _ in ()).throw(RuntimeError("receipt store unavailable")),
            trace_id="b" * 32, claim_token="owner-1",
        )
    assert [entry[0] for entry in calls] == ["dispatched", "observed"]
