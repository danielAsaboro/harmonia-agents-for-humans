"""Executor for sealed, mandate-authorized paid production operations."""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
from typing import Any

from .config import settings
from .generative_media import (
    GoogleMediaTransport,
    LyriaGenerator,
    MediaOperationPending,
    MediaProviderError,
    VeoGenerator,
    validate_lyria_request,
    validate_veo_request,
)
from .usage import InvocationContext, media_usage_record
from .telemetry import current_trace_id
from .production_media import inspect_media
from .web_client import (
    claim_production_operation,
    record_production_provider_operation,
    record_production_operation_failure,
    report_usage,
    reserve_budget,
    resolve_budget_reservation,
    start_production_provider_submission,
    upload_production_artifact,
    WebApiError,
)


class ProductionExecutionProtocolError(RuntimeError):
    """The durable claim or sealed operation is malformed or unsupported."""


logger = logging.getLogger("harmonia.production_executor")


def _next_poll_at() -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat()


def inspect_generated_media_bytes(data: bytes, mime: str) -> dict[str, Any]:
    suffix = ".mp4" if mime == "video/mp4" else ".mp3" if mime == "audio/mpeg" else ".wav"
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / f"generated{suffix}"
        path.write_bytes(data)
        inspection = inspect_media(path)
    if inspection["durationSec"] <= 0:
        raise ProductionExecutionProtocolError("generated media has no positive duration")
    if mime == "video/mp4" and not inspection.get("video"):
        raise ProductionExecutionProtocolError("generated video has no video stream")
    if mime.startswith("audio/") and not inspection.get("audio"):
        raise ProductionExecutionProtocolError("generated audio has no audio stream")
    return inspection


def execute_paid_production_operation(
    plan_id: str,
    operation_id: str,
    *,
    claim_token: str | None = None,
) -> dict[str, Any]:
    token = claim_token or secrets.token_urlsafe(32)
    decision = claim_production_operation(plan_id, operation_id, token)
    outcome = str(decision.get("outcome") or "")
    claim = decision.get("claim")
    if not isinstance(claim, dict):
        raise ProductionExecutionProtocolError("production claim response is missing its claim")
    if outcome == "already_succeeded":
        return {"outcome": outcome, "artifact": claim.get("artifact")}
    if outcome != "execute":
        return {"outcome": outcome}

    operation = decision.get("operation")
    if not isinstance(operation, dict):
        raise ProductionExecutionProtocolError("production claim response is missing its sealed operation")
    if operation.get("id") != operation_id or operation.get("executionAuthority") != "production_mandate":
        raise ProductionExecutionProtocolError("production operation authority binding is invalid")
    sealed_cost = operation.get("estimatedCostUsd")
    if not isinstance(sealed_cost, str) or sealed_cost != claim.get("reservedCostUsd"):
        raise ProductionExecutionProtocolError("production claim cost does not match the sealed operation")
    operation_type = operation.get("type")
    if operation_type not in {"generate_video", "extend_video", "generate_music"}:
        raise ProductionExecutionProtocolError("executor received a non-paid production operation")

    provider = "lyria" if operation_type == "generate_music" else "veo"
    role = "lyria_generator" if provider == "lyria" else "veo_generator"
    model_request = (
        validate_lyria_request(operation.get("payload"))
        if provider == "lyria"
        else validate_veo_request(operation.get("payload"))
    )
    model = str(model_request["providerModel"])
    budget_operation_id = f"production:{claim['id']}"
    try:
        reserve_budget({
            "jobId": claim["jobId"],
            "operationId": budget_operation_id,
            "stage": "production",
            "role": role,
            "model": model,
            "estimatedCostUsd": sealed_cost,
            "pricingVersion": claim.get("pricingVersion") or "sealed-production-plan",
        })
    except Exception as exc:
        rejected = isinstance(exc, WebApiError) and exc.permanent
        reason = "budget authorization rejected" if rejected else "budget reservation unavailable"
        record_production_operation_failure(
            plan_id,
            operation_id,
            claim_id=claim["id"],
            claim_token=token,
            outcome="failed",
            reason=f"{reason}: {type(exc).__name__}",
        )
        if not rejected:
            try:
                resolve_budget_reservation({
                    "jobId": claim["jobId"],
                    "operationId": budget_operation_id,
                    "outcome": "not_invoked",
                    "reason": "budget reservation response failed before provider invocation",
                })
            except Exception:  # noqa: BLE001 - the production failure receipt remains authoritative
                logger.exception("failed to reconcile pre-provider production budget %s", budget_operation_id)
        return {"outcome": "failed", "reason": reason}

    persisted_provider_id = claim.get("providerOperationId")
    active_provider_id = str(persisted_provider_id) if persisted_provider_id else None
    if provider == "lyria" and persisted_provider_id:
        raise ProductionExecutionProtocolError(
            "persisted Lyria identity cannot be resubmitted or resumed by this provider interface"
        )
    if not persisted_provider_id:
        try:
            start_production_provider_submission(
                plan_id,
                operation_id,
                claim_id=claim["id"],
                claim_token=token,
                provider=provider,
            )
        except Exception as exc:
            reason = f"provider submission authorization failed: {type(exc).__name__}"
            record_production_operation_failure(
                plan_id,
                operation_id,
                claim_id=claim["id"],
                claim_token=token,
                outcome="failed",
                reason=reason,
            )
            try:
                resolve_budget_reservation({
                    "jobId": claim["jobId"],
                    "operationId": budget_operation_id,
                    "outcome": "not_invoked",
                    "reason": "provider submission authorization failed before provider invocation",
                })
            except Exception:  # noqa: BLE001 - the production failure receipt is authoritative
                logger.exception("failed to release pre-provider production budget %s", budget_operation_id)
            return {"outcome": "failed", "reason": "provider submission authorization failed"}

    transport = GoogleMediaTransport(
        project=settings().gcp_project,
        location=settings().vertex_media_location,
    )

    def persist_provider(provider_operation_id: str) -> None:
        nonlocal active_provider_id
        record_production_provider_operation(
            plan_id,
            operation_id,
            claim_id=claim["id"],
            claim_token=token,
            provider=provider,
            provider_operation_id=provider_operation_id,
            next_poll_at=_next_poll_at(),
        )
        active_provider_id = provider_operation_id

    def quarantine(exc: Exception, outcome: str) -> None:
        reason = f"{type(exc).__name__}: {exc}"[:2000]
        try:
            record_production_operation_failure(
                plan_id,
                operation_id,
                claim_id=claim["id"],
                claim_token=token,
                outcome=outcome,
                reason=reason,
            )
        except Exception:  # noqa: BLE001 - preserve the causal production failure
            logger.exception("failed to quarantine production claim %s", claim["id"])
        try:
            resolve_budget_reservation({
                "jobId": claim["jobId"],
                "operationId": budget_operation_id,
                "outcome": "uncertain",
                "reason": "paid production provider outcome is ambiguous",
            })
        except Exception:  # noqa: BLE001 - preserve the causal production failure
            logger.exception("failed to quarantine production budget %s", budget_operation_id)

    try:
        if provider == "veo":
            generated = VeoGenerator(transport=transport).generate(
                request=model_request,
                existing_operation=str(persisted_provider_id) if persisted_provider_id else None,
                persist_operation=persist_provider,
            )
        else:
            generated = LyriaGenerator(transport=transport).generate(
                request=model_request,
                estimated_cost_usd=sealed_cost,
            )
            persist_provider(generated.provider_id)
    except MediaOperationPending as exc:
        persist_provider(exc.operation_name)
        return {"outcome": "waiting_provider", "providerOperationId": exc.operation_name}
    except MediaProviderError as exc:
        if active_provider_id and not exc.permanent:
            persist_provider(active_provider_id)
            return {"outcome": "waiting_provider", "providerOperationId": active_provider_id}
        quarantine(exc, "failed" if active_provider_id else "uncertain")
        raise
    except Exception as exc:
        quarantine(exc, "failed" if active_provider_id else "uncertain")
        raise

    try:
        inspection = inspect_generated_media_bytes(generated.data, generated.mime)
        digest = hashlib.sha256(generated.data).hexdigest()
        provider_metadata = {
            "provider": provider,
            "providerOperationId": generated.provider_id,
            "model": generated.model,
            "durationSec": generated.duration_sec,
            "estimatedCostUsd": sealed_cost,
            "inspection": inspection,
        }
        completed = upload_production_artifact(
            plan_id,
            operation_id,
            claim_id=claim["id"],
            claim_token=token,
            mime=generated.mime,
            digest=digest,
            data=generated.data,
            provider_metadata=provider_metadata,
        )
    except Exception as exc:
        quarantine(exc, "failed")
        raise
    try:
        report_usage(media_usage_record(
            invocation=InvocationContext(
                job_id=claim["jobId"],
                workspace_id=claim["workspaceId"],
                brand_id=claim["brandId"],
                user_id="production-service",
                stage="production",
                operation_id=budget_operation_id,
            ),
            role=role,
            model=generated.model,
            estimated_cost_usd=sealed_cost,
            trace_id=current_trace_id(),
        ).to_wire())
    except Exception:  # noqa: BLE001 - the durable production receipt is already complete
        logger.exception("usage reporting failed after production claim %s completed", claim["id"])
    return {"outcome": "succeeded", "claim": completed}
