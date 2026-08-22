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
from .stages import HANDLERS, dispatch
from .telemetry import configure_telemetry, extract_context

configure_telemetry()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("harmonia.worker")

app = FastAPI(title="harmonia-agent", version="1.0.0")

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


_start_telegram_if_configured()
_start_scheduler()
_start_proactive_agent()


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "harmonia-agent",
        "project": settings().gcp_project,
        "model": settings().model_id,
        "stages": sorted(HANDLERS.keys()),
    }


class PushEnvelope(dict):
    pass


@app.post("/pubsub/push")
async def pubsub_push(request: Request) -> JSONResponse:
    envelope = await request.json()
    try:
        message = envelope["message"]
        data = json.loads(base64.b64decode(message["data"]))
        job_id = str(data["jobId"])
        stage = str(data["stage"])
        attempt = int(data.get("attempt", 0))
        carrier = {str(k): str(v) for k, v in (message.get("attributes") or {}).items()}
    except Exception as exc:  # noqa: BLE001 - malformed delivery: ack to stop poison redelivery
        logger.error("malformed push envelope: %s", exc)
        return JSONResponse({"ack": True, "error": "malformed envelope"})

    token = otel_context.attach(extract_context(carrier))
    try:
        permanent = await dispatch(job_id, stage, attempt=attempt)
    finally:
        otel_context.detach(token)
    # 200 acknowledges regardless once reported; transient failures raise below
    # only when they were NOT yet reported as permanent.
    return JSONResponse({"ack": True, "permanent": permanent})


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
                stage = str(data["stage"])
                attempt = int(data.get("attempt", 0))
                carrier = {str(k): str(v) for k, v in msg.message.attributes.items()}
                token = otel_context.attach(extract_context(carrier))
                try:
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
