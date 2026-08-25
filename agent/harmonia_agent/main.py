"""FastAPI entrypoint: Pub/Sub push receiver plus health endpoint.

On Cloud Run the stage topic uses a push subscription with an OIDC service
account; invocation is authenticated by Cloud Run IAM, so the handler trusts
the platform. Locally (PUBSUB_EMULATOR_HOST set) a pull loop consumes the
same topic so development exercises the identical dispatch path."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from opentelemetry import context as otel_context

from .config import settings
from .a2ui_api import router as a2ui_router
from .ask_api import router as ask_router
from .stages import HANDLERS, dispatch
from .telemetry import configure_telemetry, extract_context
from .tenant_context import tenant_scope
from .resident_loops import resident_loops_enabled
from .durable_tick import run_durable_tick

configure_telemetry()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("harmonia.worker")

app = FastAPI(title="harmonia-agent", version="1.0.0")
app.include_router(a2ui_router)
app.include_router(ask_router)

if settings().telemetry_enabled:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

    FastAPIInstrumentor.instrument_app(app)
    HTTPXClientInstrumentor().instrument()


def _start_telegram_if_configured() -> None:
    from . import telegram_bot

    try:
        telegram_bot.start_background()
    except Exception:  # noqa: BLE001 - misconfiguration must be visible, not silent
        logger.exception("telegram bot failed to start")


def _start_scheduler() -> None:
    from . import scheduler

    scheduler.start_background()


def _start_proactive_agent() -> None:
    from . import proactive

    proactive.start_background()


if resident_loops_enabled(os.environ):
    logger.warning("development-only resident loops are enabled")
    _start_telegram_if_configured()
    _start_scheduler()
    _start_proactive_agent()
else:
    logger.info("resident loops disabled; durable external triggers are required")


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "harmonia-agent",
        "project": settings().gcp_project,
        "model": settings().model_id,
        "stages": sorted(HANDLERS.keys()),
    }


@app.post("/durable/tick")
async def durable_tick() -> dict[str, Any]:
    from datetime import datetime, timezone
    from . import proactive, scheduler
    from .web_client import claim_tick, get_workspaces, run_retention_tick, run_stage_outbox_tick

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
        ),
    }


@app.post("/durable/heartbeat")
async def resident_heartbeat() -> dict[str, Any]:
    """OIDC/IAM-protected hourly wake; the controller itself is model-free by default."""
    from datetime import datetime, timezone
    from .heartbeat import run_heartbeat
    from .web_client import claim_autonomy_cycle, finalize_autonomy_cycle, get_feed, get_workspaces, run_retention_tick, run_stage_outbox_tick
    from .tenant_context import tenant_scope
    scheduled_at = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0).isoformat()
    results = []
    for scope in await asyncio.to_thread(get_workspaces):
        with tenant_scope(scope["workspaceId"], scope["brandId"]):
            feed = await asyncio.to_thread(get_feed)
            result = await run_heartbeat(scheduled_at=scheduled_at, claim_cycle=claim_autonomy_cycle, finalize_cycle=finalize_autonomy_cycle, stage_outbox=run_stage_outbox_tick, recover_missed=lambda: [], inspect_stuck=lambda: list(feed.get("failedJobs") or []), provider_health=lambda: {"status": "configured"}, budget_health=lambda: {"available": False, "reason": "no cognitive arm due"}, maintenance=lambda: run_retention_tick(20))
            results.append({"workspaceId": scope["workspaceId"], **result})
    return {"ok": True, "scheduledAt": scheduled_at, "workspaces": results}


@app.post("/durable/dream")
async def resident_dream() -> dict[str, Any]:
    """Authenticated nightly wake. Persistence/model adapters remain fail-closed until eligible evidence exists."""
    from datetime import datetime, timezone
    return {"ok": True, "status": "deferred", "reason": "eligible observation feed not yet materialized for this wake", "scheduledAt": datetime.now(timezone.utc).isoformat()}


@app.post("/durable/wakeup")
async def resident_wakeup() -> dict[str, Any]:
    """Authenticated morning wake; never invents a briefing without persisted Dream results."""
    from datetime import datetime, timezone
    return {"ok": True, "status": "deferred", "reason": "no persisted Dream result available", "scheduledAt": datetime.now(timezone.utc).isoformat()}


class PushEnvelope(dict):
    pass


@app.post("/pubsub/push")
async def pubsub_push(request: Request) -> JSONResponse:
    envelope = await request.json()
    try:
        message = envelope["message"]
        data = json.loads(base64.b64decode(message["data"]))
        job_id = str(data["jobId"])
        workspace_id = str(data["workspaceId"])
        brand_id = str(data["brandId"])
        stage = str(data["stage"])
        delivery_attempt = max(int(envelope.get("deliveryAttempt", 1)) - 1, 0)
        attempt = max(int(data.get("attempt", 0)), delivery_attempt)
        carrier = {str(k): str(v) for k, v in (message.get("attributes") or {}).items()}
        if carrier.get("workspaceId") != workspace_id or carrier.get("brandId") != brand_id:
            raise ValueError("tenant attributes do not match stage payload")
    except Exception as exc:  # noqa: BLE001 - malformed delivery: ack to stop poison redelivery
        logger.error("malformed push envelope: %s", exc)
        return JSONResponse({"ack": True, "error": "malformed envelope"})

    token = otel_context.attach(extract_context(carrier))
    try:
        with tenant_scope(workspace_id, brand_id):
            acknowledge = await dispatch(job_id, stage, attempt=attempt)
    finally:
        otel_context.detach(token)
    # 200 acknowledges regardless once reported; transient failures raise below
    # only when they were NOT yet reported as permanent.
    if not acknowledge:
        return JSONResponse(
            {"ack": False, "retryable": True, "attempt": attempt},
            status_code=503,
        )
    return JSONResponse({"ack": True, "retryable": False, "attempt": attempt})


def _run_pull_loop() -> None:
    from google.cloud import pubsub_v1

    project = settings().gcp_project
    topic_name = os.environ.get("PUBSUB_STAGE_TOPIC", "harmonia-stages")
    subscriber = pubsub_v1.SubscriberClient()
    subscription_path = subscriber.subscription_path(project, f"{topic_name}-local-pull")

    def ensure_subscription() -> None:
        from google.cloud import pubsub_v1 as ps

        publisher = ps.PublisherClient()
        topic_path = publisher.topic_path(project, topic_name)
        try:
            publisher.create_topic(name=topic_path)
        except Exception:  # noqa: BLE001 - already exists
            pass
        try:
            subscriber.create_subscription(
                name=subscription_path, topic=topic_path, ack_deadline_seconds=120
            )
        except Exception:  # noqa: BLE001 - already exists
            pass

    ensure_subscription()
    logger.info("local pull loop started on %s", subscription_path)

    while True:
        response = subscriber.pull(subscription=subscription_path, max_messages=1, timeout=15)
        if not response.received_messages:
            continue
        for msg in response.received_messages:
            try:
                data = json.loads(msg.message.data.decode("utf-8"))
                job_id = str(data["jobId"])
                workspace_id = str(data["workspaceId"])
                brand_id = str(data["brandId"])
                stage = str(data["stage"])
                delivery_attempt = max(int(getattr(msg, "delivery_attempt", 1) or 1) - 1, 0)
                attempt = max(int(data.get("attempt", 0)), delivery_attempt)
                carrier = {str(k): str(v) for k, v in msg.message.attributes.items()}
                if carrier.get("workspaceId") != workspace_id or carrier.get("brandId") != brand_id:
                    raise ValueError("tenant attributes do not match stage payload")
                token = otel_context.attach(extract_context(carrier))
                try:
                    with tenant_scope(workspace_id, brand_id):
                        permanent = asyncio.run(dispatch(job_id, stage, attempt=attempt))
                finally:
                    otel_context.detach(token)
                if permanent:
                    subscriber.acknowledge(subscription=subscription_path, ack_ids=[msg.ack_id])
                else:
                    subscriber.modify_ack_deadline(
                        subscription=subscription_path, ack_ids=[msg.ack_id], ack_deadline_seconds=0
                    )
                    logger.warning("transient failure; nacked for redelivery")
            except Exception:  # noqa: BLE001 - keep looping
                logger.exception("pull processing error")
                subscriber.acknowledge(subscription=subscription_path, ack_ids=[msg.ack_id])


def _start_pull_loop_if_emulator() -> None:
    if os.environ.get("PUBSUB_EMULATOR_HOST"):
        threading.Thread(target=_run_pull_loop, daemon=True).start()


_start_pull_loop_if_emulator()
