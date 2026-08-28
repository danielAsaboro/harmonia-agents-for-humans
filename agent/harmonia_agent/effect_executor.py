"""Single claim-before-effect executor for immediate and scheduled commands."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import uuid
from typing import Any, Callable, Mapping

from .telemetry import current_trace_id
from .operation_context import operation_scope

Adapter = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class ExecutionResult:
    outcome: str
    receipt_id: str | None = None


class ProviderEffectNotStarted(RuntimeError):
    """Adapter proof that control never entered the external provider."""


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


def linkedin_publish_adapter(payload: dict[str, Any], access_token: str) -> dict[str, Any]:
    from .linkedin_client import LinkedInClient

    body, destination = payload.get("body"), payload.get("destination")
    if not isinstance(body, str) or not body or not isinstance(destination, dict):
        raise ValueError("LinkedIn effect command requires exact body and destination")
    posted = LinkedInClient(access_token).publish_post(body, destination)
    return {
        "outcome": "applied",
        "artifact": {"kind": "linkedin_api", "url": posted["url"], "fetchedAt": datetime.now(timezone.utc).isoformat(), "digest": hashlib.sha256(body.encode()).hexdigest()},
        "detail": dict(posted),
    }


def production_adapters(x_access_token: str = "", linkedin_access_token: str = "") -> dict[str, Adapter]:
    adapters: dict[str, Adapter] = {}
    if x_access_token:
        adapters["publish_x_post"] = lambda payload: x_publish_adapter(payload, x_access_token)
    if linkedin_access_token:
        adapters["publish_linkedin_post"] = lambda payload: linkedin_publish_adapter(payload, linkedin_access_token)
    return adapters


def execute_effect_command(
    command: dict[str, Any],
    *,
    adapters: Mapping[str, Adapter],
    claim: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    transition: Callable[[str, dict[str, Any]], Any] | None = None,
    finalize: Callable[[dict[str, Any]], Any] | None = None,
    trace_id: str | None = None,
    claim_token: str | None = None,
) -> ExecutionResult:
    from .web_client import claim_effect, post, transition_effect_command

    claim = claim or claim_effect
    transition = transition or transition_effect_command
    finalize = finalize or (lambda payload: post("/api/internal/receipt", payload))
    trace_id = trace_id or current_trace_id()
    claim_token = claim_token or uuid.uuid4().hex
    operation_id = f"job:{command['jobId']}:effect:{command['id']}"
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
    epoch = int(claimed.get("operationEpoch") or 0)
    if epoch < 1:
        raise RuntimeError("effect claim is missing its operation epoch")
    goal_digest = claimed.get("goalDigest")
    fenced = {**identity, "operationEpoch": epoch}
    with operation_scope(
        operation_id, epoch,
        goal_digest=str(goal_digest) if goal_digest else None,
    ):
        transition("dispatched", {**fenced, "attempt": int(claimed.get("attempt") or 1)})
        try:
            adapter_result = adapter(dict(command["payload"]))
        except ProviderEffectNotStarted:
            transition("provider_not_started", fenced)
            raise
        except Exception as exc:
            transition("unknown", {**fenced, "reason": f"{type(exc).__name__}: {exc}"})
            return ExecutionResult("unknown")

        outcome = str(adapter_result.get("outcome"))
        if outcome not in {"applied", "already_applied", "rejected", "failed"}:
            transition("unknown", {**fenced, "reason": f"invalid adapter outcome: {outcome}"})
            return ExecutionResult("unknown")
        artifact = adapter_result.get("artifact")
        detail = dict(adapter_result.get("detail") or {})
        transition("observed", {
            **fenced, "outcome": outcome, "artifact": artifact, "detail": detail,
        })
        finalize({**identity, "outcome": outcome, "artifact": artifact, "detail": detail})
        return ExecutionResult(outcome)
