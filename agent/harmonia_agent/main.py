"""Private AWS worker: SQS dispatch, durable scheduler and authenticated APIs."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from typing import Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from opentelemetry import context as otel_context

from .config import settings
from .a2ui_api import router as a2ui_router
from .ask_api import router as ask_router
from .intent_api import router as intent_router
from .extraction_api import router as extraction_router
from .stages import HANDLERS, dispatch
from .telemetry import configure_telemetry, extract_context
from .tenant_context import tenant_scope
from .durable_tick import run_durable_tick
from .operation_context import operation_scope
from .production_executor import execute_production_operation
from .web_client import WebApiError, claim_event_inbox, claim_operation, complete_event_inbox

configure_telemetry()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("harmonia.worker")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    from .sqs_transport import consume
    from .data_consumer import handle_data
    tasks = []
    for env, handler in (("SQS_STAGE_QUEUE_URL", _handle_stage),
                         ("SQS_PRODUCTION_QUEUE_URL", _handle_production),
                         ("SQS_CONTROL_QUEUE_URL", _handle_control),
                         ("SQS_DATA_QUEUE_URL", handle_data)):
        queue = os.environ.get(env)
        if queue and os.environ.get("HARMONIA_ENABLE_QUEUE_CONSUMERS") == "true":
            tasks.append(asyncio.create_task(consume(queue, handler, region=settings().aws_region)))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="harmonia-worker", version="2.0.0", lifespan=lifespan)


@app.middleware("http")
async def authenticate_internal(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)
    expected = "Bearer " + settings().internal_api_token
    supplied = request.headers.get("authorization", "")
    if not secrets.compare_digest(supplied, expected):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)

app.include_router(a2ui_router)
app.include_router(ask_router)
app.include_router(intent_router)
app.include_router(extraction_router)

if settings().telemetry_enabled:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    config = settings()
    return {
        "ok": True,
        "service": "harmonia-agent",
        "region": config.aws_region,
        "model": config.model_id,
        "stages": sorted(HANDLERS.keys()),
        "durableRuntime": {
            "protocolVersion": 1,
            "stateStore": "dynamodb",
            "wakeTransport": "sqs",
            "contextCompiler": "harmonia-context/v1",
            "recovery": {
                "limit": config.durable_recovery_limit,
                "deadlineSeconds": config.durable_recovery_deadline_seconds,
                "maxRetries": config.durable_recovery_max_retries,
            },
        },
    }


@app.post("/durable/recover")
async def durable_recover() -> dict[str, Any]:
    """OIDC/IAM-protected, model-free recovery wake with deployment bounds."""
    from .recovery import recover_missed
    from .web_client import get_workspaces, recover_blob_erasures

    from .knowledge_index import recover_knowledge_erasures
    await asyncio.to_thread(recover_knowledge_erasures)
    await asyncio.to_thread(recover_blob_erasures)
    config = settings()
    results = []
    action_count = 0
    for scope in await asyncio.to_thread(get_workspaces):
        with tenant_scope(scope["workspaceId"], scope["brandId"]):
            actions = await asyncio.to_thread(
                recover_missed,
                limit=config.durable_recovery_limit,
                deadline_seconds=config.durable_recovery_deadline_seconds,
                max_retries=config.durable_recovery_max_retries,
                max_cost_usd=config.durable_recovery_max_cost_usd,
            )
        action_count += len(actions)
        results.append({
            "workspaceId": scope["workspaceId"],
            "actionCount": len(actions),
            "actions": actions,
        })
    return {"ok": True, "workspaces": results, "actionCount": action_count}


@app.post("/durable/tick")
async def durable_tick() -> dict[str, Any]:
    from datetime import datetime, timezone
    from . import proactive, scheduler
    from .recovery import recover_missed
    from .web_client import (
        claim_tick,
        recover_blob_erasures,
        get_workspaces,
        run_production_outbox_tick,
        run_retention_tick,
        run_stage_outbox_tick,
    )

    from .knowledge_index import recover_knowledge_erasures
    await asyncio.to_thread(recover_knowledge_erasures)
    await asyncio.to_thread(recover_blob_erasures)
    workspaces = await asyncio.to_thread(get_workspaces)
    claim_id = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    return {
        "ok": True,
        "claimId": claim_id,
        "workspaces": await run_durable_tick(
            workspaces,
            claim_id,
            claim=claim_tick,
            scheduled=scheduler.tick_current_tenant,
            proactive=proactive.tick,
            retention=run_retention_tick,
            stage_outbox=run_stage_outbox_tick,
            production_outbox=run_production_outbox_tick,
            recovery=recover_missed,
        ),
    }


def _valid_production_wake(body: Any) -> dict[str, Any] | None:
    if not isinstance(body, dict):
        return None
    required = ("workspaceId", "brandId", "planId", "operationId")
    if any(not isinstance(body.get(key), str) or not body[key] for key in required):
        return None
    if any(len(body[key]) > 256 for key in required):
        return None
    if not isinstance(body.get("internalRun"), int) or body["internalRun"] < 0:
        return None
    if not isinstance(body.get("planRevision"), int) or body["planRevision"] < 1:
        return None
    plan_digest = body.get("planDigest")
    if not isinstance(plan_digest, str) or len(plan_digest) != 64 or any(char not in "0123456789abcdef" for char in plan_digest):
        return None
    return {
        **{key: body[key] for key in required},
        "planRevision": body["planRevision"], "planDigest": plan_digest,
        "internalRun": body["internalRun"],
    }


async def _run_production_wake(body: dict[str, Any]) -> dict[str, Any]:
    with tenant_scope(body["workspaceId"], body["brandId"]):
        return await asyncio.to_thread(
            execute_production_operation,
            body["planId"],
            body["operationId"],
            plan_revision=body["planRevision"],
            plan_digest=body["planDigest"],
            internal_run=body["internalRun"],
        )


@app.post("/production/execute")
async def production_execute(request: Request) -> JSONResponse:
    """IAM-protected direct wake for one exact sealed production operation."""
    try:
        body = _valid_production_wake(await request.json())
    except Exception:  # noqa: BLE001 - malformed wake is a bounded client error
        body = None
    if body is None:
        return JSONResponse({"error": "invalid production operation wake"}, status_code=400)
    return JSONResponse(await _run_production_wake(body))


@app.post("/durable/heartbeat")
async def resident_heartbeat() -> dict[str, Any]:
    """OIDC/IAM-protected hourly wake; the controller itself is model-free by default."""
    from datetime import datetime, timezone
    from .heartbeat import run_heartbeat
    from .web_client import claim_autonomy_cycle, finalize_autonomy_cycle, get_feed, get_workspaces, run_retention_tick, run_stage_outbox_tick
    from .recovery import recover_missed
    from .tenant_context import tenant_scope
    scheduled_at = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0).isoformat()
    results = []
    for scope in await asyncio.to_thread(get_workspaces):
        with tenant_scope(scope["workspaceId"], scope["brandId"]):
            feed = await asyncio.to_thread(get_feed)
            result = await run_heartbeat(scheduled_at=scheduled_at, claim_cycle=claim_autonomy_cycle, finalize_cycle=finalize_autonomy_cycle, stage_outbox=run_stage_outbox_tick, recover_missed=recover_missed, inspect_stuck=lambda: list(feed.get("failedJobs") or []), provider_health=lambda: {"status": "configured"}, budget_health=lambda: {"available": False, "reason": "no cognitive arm due"}, maintenance=lambda: run_retention_tick(20))
            results.append({"workspaceId": scope["workspaceId"], **result})
    return {"ok": True, "scheduledAt": scheduled_at, "workspaces": results}


@app.post("/durable/dream")
async def resident_dream() -> dict[str, Any]:
    from .resident_runtime import run_resident_cycle
    return await run_resident_cycle("dream")


@app.post("/durable/wakeup")
async def resident_wakeup() -> dict[str, Any]:
    from .resident_runtime import run_resident_cycle
    return await run_resident_cycle("wakeup")


def _stage_delivery(
    data: dict[str, Any], carrier: dict[str, str]
) -> tuple[str, str, str, str, int]:
    if int(data.get("schemaVersion", 0)) != 1:
        raise ValueError("unsupported stage event schema")
    if str(data.get("source")) != "stage_outbox":
        raise ValueError("unsupported stage event source")
    if str(data.get("eventType")) != "stage.requested":
        raise ValueError("unsupported stage event type")
    workspace_id = str(data["workspaceId"])
    brand_id = str(data["brandId"])
    job_id = str(data["jobId"])
    operation_id = str(data["operationId"])
    source_event_id = str(data["sourceEventId"])
    payload = data.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("stage event payload is missing")
    stage = str(payload["stage"])
    attempt = int(data.get("attempt", 0))
    if attempt < 0:
        raise ValueError("stage event attempt is invalid")
    expected = {
        "workspaceId": workspace_id,
        "brandId": brand_id,
        "sourceEventId": source_event_id,
        "operationId": operation_id,
    }
    if any(carrier.get(key) != value for key, value in expected.items()):
        raise ValueError("stage event attributes do not match payload")
    return workspace_id, brand_id, job_id, stage, attempt


async def _process_stage_event(
    data: dict[str, Any],
    carrier: dict[str, str],
    message_id: str,
    delivery_attempt: int,
) -> tuple[bool, dict[str, Any]]:
    workspace_id, brand_id, job_id, stage, source_attempt = _stage_delivery(data, carrier)
    # SQS delivery attempts are transport retries, not cognitive-stage
    # generations. Advancing the stage retry budget on redelivery can turn a
    # recoverable provider interruption into a false terminal failure.
    attempt = source_attempt
    operation_id = str(data["operationId"])
    event_token = secrets.token_urlsafe(32)
    with tenant_scope(workspace_id, brand_id):
        event_claim = await asyncio.to_thread(claim_event_inbox, {
            "envelope": data,
            "transportMessageId": message_id,
            "claimToken": event_token,
        })
        if event_claim["outcome"] != "execute":
            return True, {
                "ack": True,
                "retryable": False,
                "duplicate": True,
                "eventOutcome": event_claim["outcome"],
                "attempt": attempt,
            }

        operation_token = secrets.token_urlsafe(32)
        operation_claim = await asyncio.to_thread(claim_operation, {
            "operationId": operation_id,
            "ownerId": f"worker:{os.getpid()}",
            "claimToken": operation_token,
        })
        if operation_claim["outcome"] != "execute":
            return True, {
                "ack": True,
                "retryable": False,
                "duplicate": True,
                "operationOutcome": operation_claim["outcome"],
                "attempt": attempt,
            }

        epoch = int(operation_claim["operation"]["epoch"])
        goal_digest = str((operation_claim["operation"].get("goal") or {}).get("digest") or "")
        with operation_scope(operation_id, epoch, goal_digest=goal_digest or None):
            acknowledge = await dispatch(job_id, stage, attempt=attempt, operation_id=operation_id)
            if not acknowledge:
                return False, {"ack": False, "retryable": True, "attempt": attempt}
            failed = acknowledge == "failed"
            await asyncio.to_thread(complete_event_inbox, {
                "source": str(data["source"]),
                "sourceEventId": str(data["sourceEventId"]),
                "claimToken": event_token,
                "outcome": "rejected" if failed else "completed",
                **({"rejectionReason": "stage handler failed"} if failed else {}),
                "operationEpoch": epoch,
                "operationState": "failed" if failed else "succeeded",
            })
        return True, {"ack": True, "retryable": False, "attempt": attempt, **({"failed": True} if failed else {})}


async def _handle_stage(data, carrier, message_id, delivery_attempt):
    _stage_delivery(data, carrier)
    token = otel_context.attach(extract_context(carrier))
    try:
        acknowledge, _ = await _process_stage_event(data, carrier, message_id, delivery_attempt)
        return acknowledge
    finally:
        otel_context.detach(token)


async def _handle_production(data, carrier, _message_id, _delivery_attempt):
    body = _valid_production_wake(data)
    if body is None or any(carrier.get(key) != str(body[key]) for key in body):
        raise ValueError("production wake scope mismatch")
    result = await _run_production_wake(body)
    return not result.get("retryable", False)


async def _handle_control(data, _carrier, _message_id, _delivery_attempt):
    kind = data.get("kind")
    handlers = {"tick": durable_tick, "recover": durable_recover,
                "heartbeat": resident_heartbeat, "dream": resident_dream,
                "wakeup": resident_wakeup}
    handler = handlers.get(kind)
    if handler is None:
        raise ValueError("unknown scheduler wake")
    if kind in {"heartbeat", "dream", "wakeup"} and os.environ.get("HARMONIA_ENABLE_RESIDENT_AUTONOMY") != "true":
        return True
    result = await handler()
    return result.get("ok") is True
