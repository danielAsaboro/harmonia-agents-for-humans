"""Single claim-before-effect executor for immediate and scheduled commands."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import uuid
from typing import Any, Callable, Mapping

from .telemetry import current_trace_id

Adapter = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class ExecutionResult:
    outcome: str
    receipt_id: str | None = None


def x_publish_adapter(payload: dict[str, Any], bearer_token: str | None = None) -> dict[str, Any]:
    from . import x_client

    text = payload.get("text")
    if not isinstance(text, str) or not text:
        raise ValueError("X effect command has no text")
    posted = x_client.publish_post(text, bearer_token)
    return {
        "outcome": "applied",
        "artifact": {
            "kind": "x_api", "url": posted["url"],
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "digest": hashlib.sha256(text.encode()).hexdigest(),
        },
        "detail": dict(posted),
    }


def production_adapters(x_access_token: str) -> dict[str, Adapter]:
    return {"publish_x_post": lambda payload: x_publish_adapter(payload, x_access_token)}


def execute_effect_command(
    command: dict[str, Any],
    *,
    adapters: Mapping[str, Adapter],
    claim: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    finalize: Callable[[dict[str, Any]], Any] | None = None,
    trace_id: str | None = None,
    claim_token: str | None = None,
) -> ExecutionResult:
    from .web_client import claim_effect, post

    claim = claim or claim_effect
    finalize = finalize or (lambda payload: post("/api/internal/receipt", payload))
    trace_id = trace_id or current_trace_id()
    claim_token = claim_token or uuid.uuid4().hex
    operation_id = f"{command['jobId']}:effect:{command['id']}:{trace_id}"
    identity = {
        "commandId": command["id"],
        "jobId": command["jobId"],
        "actionId": command["actionId"],
        "actionType": command["actionType"],
        "idempotencyKey": command["payloadDigest"],
        "operationId": operation_id,
        "traceId": trace_id,
        "claimToken": claim_token,
    }
    claimed = claim(identity)
    claim_outcome = claimed.get("outcome")
    if claim_outcome != "execute":
        if claim_outcome not in {"in_progress", "already_applied", "uncertain"}:
            raise RuntimeError(f"invalid effect claim outcome: {claim_outcome}")
        return ExecutionResult(str(claim_outcome), claimed.get("receiptId"))

    adapter = adapters.get(str(command["actionType"]))
    if adapter is None:
        raise RuntimeError(f"no adapter for effect command type '{command['actionType']}'")
    try:
        adapter_result = adapter(dict(command["payload"]))
        outcome = str(adapter_result.get("outcome"))
        if outcome not in {"applied", "already_applied", "rejected", "failed"}:
            raise RuntimeError(f"invalid adapter outcome: {outcome}")
        artifact = adapter_result.get("artifact")
        detail = dict(adapter_result.get("detail") or {})
    except Exception as exc:  # provider failure must become a durable failed receipt
        outcome, artifact, detail = "failed", None, {"error": f"{type(exc).__name__}: {exc}"}
    finalize({**identity, "outcome": outcome, "artifact": artifact, "detail": detail})
    return ExecutionResult(outcome)
