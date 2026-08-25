from harmonia_agent.effect_executor import execute_effect_command


def _command():
    return {
        "id": "command-1", "jobId": "job-1", "actionId": "action-1",
        "actionType": "publish_x_post", "payload": {"text": "Launch"},
        "payloadDigest": "a" * 64,
    }


def test_non_execute_claim_never_enters_provider():
    for outcome in ("in_progress", "already_applied", "uncertain"):
        calls = []
        result = execute_effect_command(
            _command(), adapters={"publish_x_post": lambda _payload: calls.append("provider")},
            claim=lambda _payload, outcome=outcome: {"outcome": outcome, "receiptId": "r1"},
            finalize=lambda _payload: calls.append("finalize"), trace_id="b" * 32, claim_token="owner-1",
        )
        assert calls == []
        assert result.outcome == outcome


def test_execute_claim_uses_command_payload_and_finalizes_once():
    calls = []
    result = execute_effect_command(
        _command(),
        adapters={"publish_x_post": lambda payload: calls.append(payload) or {"outcome": "applied", "detail": {"id": "post-1"}}},
        claim=lambda _payload: {"outcome": "execute", "attempt": 1},
        finalize=lambda payload: calls.append(payload), trace_id="b" * 32, claim_token="owner-1",
    )
    assert calls[0] == {"text": "Launch"}
    assert calls[1]["commandId"] == "command-1"
    assert result.outcome == "applied"
