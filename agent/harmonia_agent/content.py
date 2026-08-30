"""Direct Gemini media operations plus deterministic content-pack assembly."""

from __future__ import annotations

import json
import io
import logging
import os
from math import ceil
from collections.abc import Callable
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any

from google import genai

from .config import settings
from .model_catalog import PRICING_VERSION, estimate_text_cost
from .telemetry import current_trace_id, safe_attributes, tracer
from .usage import InvocationContext, UsageAccumulator, UsageRecord, estimate_request_tokens
from .web_client import report_usage, reserve_budget, resolve_budget_reservation
from . import youtube

MODEL = "gemini-3.7-flash"
IMAGE_MODEL = os.environ.get("IMAGE_MODEL_ID", "gemini-3.5-flash-image")
# Base64 expands bytes by roughly 4/3. Keep inline media comfortably below
# generateContent's 20 MiB total-request limit, including the text envelope.
MAX_INLINE_MEDIA_BYTES = 14 * 1024 * 1024
logger = logging.getLogger("harmonia.content")


def _resolve_without_masking(
    resolver: Callable[[dict[str, object]], None], payload: dict[str, object],
) -> None:
    try:
        resolver(payload)
    except Exception:  # noqa: BLE001 - preserve the causal provider failure
        logger.exception("budget resolution failed for operation %s", payload["operationId"])


def _client() -> genai.Client:
    key = settings().gemini_api_key
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not configured")
    return genai.Client(api_key=key)


def _parse_json(text: str) -> Any:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    return json.loads(cleaned)


def model_used() -> str:
    return os.environ.get("TRANSCRIBER_MODEL_ID", MODEL)


def transcribe_audio(
    audio: bytes,
    mime_type: str,
    *,
    invocation: InvocationContext | None = None,
    budget_reserver: Callable[[dict[str, object]], None] = reserve_budget,
    budget_resolver: Callable[[dict[str, object]], None] = resolve_budget_reservation,
    usage_reporter: Callable[[dict[str, object]], None] = report_usage,
) -> dict:
    if invocation is None:
        raise ValueError("real transcription requires invocation context")
    role = "transcriber"
    model = model_used()
    operation_id = invocation.role_operation_id(role)
    prompt = (
        "Transcribe this audio. Return JSON: "
        "{language, segments:[{id,startSec,endSec,text}]}. "
        "startSec/endSec are numbers."
    )
    prompt_input, estimated_output = estimate_request_tokens(prompt, 4096)
    estimated_input = ceil(youtube.probe_audio_duration(audio) * 32) + prompt_input
    budget_reserver({
        "jobId": invocation.job_id,
        "operationId": operation_id,
        "stage": invocation.stage,
        "role": role,
        "model": model,
        "estimatedCostUsd": str(estimate_text_cost(
            model, estimated_input, estimated_output,
        )),
        "pricingVersion": PRICING_VERSION,
    })
    dispatched = False
    try:
        client = _client()
        with tracer().start_as_current_span("harmonia.model.generate") as span:
            span.set_attributes(safe_attributes({
                "job.id": invocation.job_id,
                "stage": invocation.stage,
                "agent": role,
                "model": MODEL,
            }))
            if len(audio) <= MAX_INLINE_MEDIA_BYTES:
                media_content: Any = {"role": "user", "parts": [
                    {"inlineData": {
                        "mimeType": mime_type,
                        "data": __import__("base64").b64encode(audio).decode(),
                    }},
                    {"text": prompt},
                ]}
            else:
                dispatched = True
                uploaded = client.files.upload(
                    file=io.BytesIO(audio),
                    config={
                        "mime_type": mime_type,
                        "display_name": "harmonia-transcription-media",
                    },
                )
                media_content = [uploaded, prompt]
            dispatched = True
            res = client.models.generate_content(
                model=model,
                contents=media_content,
            )
            result = _parse_json(res.text)
            accumulator = UsageAccumulator(
                job_id=invocation.job_id,
                operation_id=operation_id,
                stage=invocation.stage,
                role=role,
                model=model,
            )
            accumulator.observe_event(res)
            record = accumulator.finalize(trace_id=current_trace_id())
            span.set_attributes(safe_attributes({
                "input.units": record.input_units,
                "output.units": record.output_units,
                "cost.estimated_usd": record.estimated_cost_usd,
            }))
            usage_reporter(record.to_wire())
            return result
    except Exception:  # noqa: BLE001 - preserve the original provider failure
        _resolve_without_masking(budget_resolver, {
            "jobId": invocation.job_id,
            "operationId": operation_id,
            "outcome": "uncertain" if dispatched else "not_invoked",
            "reason": (
                "transcription failed after provider dispatch"
                if dispatched else "transcription failed before provider dispatch"
            ),
        })
        raise


class ImageGenError(RuntimeError):
    pass


def generate_image(
    prompt: str,
    *,
    invocation: InvocationContext | None = None,
    budget_reserver: Callable[[dict[str, object]], None] = reserve_budget,
    budget_resolver: Callable[[dict[str, object]], None] = resolve_budget_reservation,
    usage_reporter: Callable[[dict[str, object]], None] = report_usage,
) -> tuple[bytes, str]:
    """Generate an image with Gemini and return its bytes and MIME type."""
    if invocation is None:
        raise ValueError("real image generation requires invocation context")
    role = "image_generator"
    operation_id = invocation.role_operation_id(role)
    maximum_cost = settings().image_max_cost_usd
    budget_reserver({
        "jobId": invocation.job_id,
        "operationId": operation_id,
        "stage": invocation.stage,
        "role": role,
        "model": IMAGE_MODEL,
        "estimatedCostUsd": maximum_cost,
        "pricingVersion": PRICING_VERSION,
    })
    dispatched = False
    try:
        client = _client()
        with tracer().start_as_current_span("harmonia.model.generate") as span:
            span.set_attributes(safe_attributes({
                "job.id": invocation.job_id,
                "stage": invocation.stage,
                "agent": role,
                "model": IMAGE_MODEL,
            }))
            dispatched = True
            res = client.models.generate_images(model=IMAGE_MODEL, contents=prompt)
            images = getattr(res, "generated_images", None)
            if not images:
                raise ImageGenError(f"{IMAGE_MODEL} returned no images")
            img = images[0].image
            record = UsageRecord(
                id=f"usage-{sha256(operation_id.encode()).hexdigest()[:24]}",
                job_id=invocation.job_id,
                operation_id=operation_id,
                stage=invocation.stage,
                role=role,
                model=IMAGE_MODEL,
                input_units=1,
                output_units=0,
                unit_type="images",
                estimated_cost_usd=maximum_cost,
                trace_id=current_trace_id(),
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            span.set_attributes(safe_attributes({
                "input.units": 1,
                "output.units": 0,
                "cost.estimated_usd": maximum_cost,
            }))
            usage_reporter(record.to_wire())
            return img.image_bytes, getattr(img, "mime_type", None) or "image/png"
    except Exception as exc:  # noqa: BLE001 - normalized for stage failure classification
        _resolve_without_masking(budget_resolver, {
            "jobId": invocation.job_id,
            "operationId": operation_id,
            "outcome": "uncertain" if dispatched else "not_invoked",
            "reason": (
                "provider request outcome is unknown after dispatch"
                if dispatched else "provider request was not dispatched"
            ),
        })
        if isinstance(exc, ImageGenError):
            raise
        raise ImageGenError(f"image generation failed: {exc}") from exc


def build_content_pack(title: str, url: str, moments: list, angles: list, drafts: list) -> str:
    lines = [f"# Harmonia Content Pack — {title}", "", f"Source: {url}", ""]
    lines.append("## Clip moments")
    for moment in moments:
        lines.append(
            f"- **{moment['title']}** ({int(moment['startSec'])}s–{int(moment['endSec'])}s): "
            f"{moment['hook']}"
        )
        lines.append(f'  > "{moment["quote"]}"')
    lines.append("\n## Trend & meme angles")
    for angle in angles:
        lines.append(f"- [{angle['kind'].upper()}] {angle['title']} — {angle['rationale']}")
    lines.append("\n## Ready-to-post drafts")
    for draft in drafts:
        lines.append(f"### {draft['platform'].upper()}")
        lines.append(f"> {draft['text']}")
    lines.append("\n---\nAssembled by Harmonia from persisted pipeline artifacts.")
    return "\n".join(lines)
