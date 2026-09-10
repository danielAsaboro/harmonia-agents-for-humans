"""Native Transcribe timed speech, Nova Canvas images, deterministic packs."""
from __future__ import annotations
import base64
import json
import os
import time
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
import boto3
from botocore.exceptions import ClientError
from botocore.config import Config
from .config import settings
from .usage import InvocationContext, UsageRecord
from .telemetry import current_trace_id
from .web_client import report_usage, reserve_budget, resolve_budget_reservation
from . import youtube

IMAGE_MODEL = "amazon.nova-canvas-v1:0"
class ImageGenError(RuntimeError): pass

def model_used(): return "amazon-transcribe"
def _enabled():
    configured = settings()
    if not configured.allow_paid_aws: raise RuntimeError("paid AWS operations disabled")
    return configured

def _usage(invocation, role, model, cost, units, unit_type, reporter):
    operation = invocation.role_operation_id(role)
    record = UsageRecord(id=f"usage-{sha256(operation.encode()).hexdigest()[:24]}", job_id=invocation.job_id, operation_id=operation, stage=invocation.stage, role=role, model=model, input_units=units, output_units=0, unit_type=unit_type, estimated_cost_usd=cost, trace_id=current_trace_id(), created_at=datetime.now(timezone.utc).isoformat())
    reporter(record.to_wire())

def _reserve(invocation, role, model, cost, reserver):
    if not Decimal(cost).is_finite() or Decimal(cost) <= 0: raise ValueError("positive configured price required")
    reserver({"jobId": invocation.job_id, "operationId": invocation.role_operation_id(role), "stage": invocation.stage, "role": role, "model": model, "estimatedCostUsd": cost, "pricingVersion": "configured-aws-media-v1"})

def _failed(invocation, role, dispatched, resolver):
    try: resolver({"jobId": invocation.job_id, "operationId": invocation.role_operation_id(role), "outcome": "uncertain" if dispatched else "not_invoked", "reason": "provider outcome requires reconciliation" if dispatched else "provider not invoked"})
    except Exception: pass

def transcribe_audio(audio, mime_type, *, invocation=None, budget_reserver=reserve_budget, budget_resolver=resolve_budget_reservation, usage_reporter=report_usage):
    if invocation is None: raise ValueError("real transcription requires invocation context")
    config = _enabled()
    if not config.media_output_bucket: raise ValueError("S3_BUCKET required")
    duration = youtube.probe_audio_duration(audio)
    rate = os.environ.get("TRANSCRIBE_COST_PER_SECOND_USD")
    if not rate: raise ValueError("TRANSCRIBE_COST_PER_SECOND_USD required")
    cost = f"{Decimal(rate) * Decimal(str(max(15, duration))):.6f}"
    _reserve(invocation, "transcriber", model_used(), cost, budget_reserver)
    identity = sha256(f"{invocation.workspace_id}:{invocation.role_operation_id('transcriber')}:{sha256(audio).hexdigest()}".encode()).hexdigest()
    job_name = f"harmonia-{identity}"
    prefix = f"transcription/{identity}/"
    s3 = boto3.client("s3", region_name=config.aws_region)
    transcribe = boto3.client("transcribe", region_name=config.aws_region, config=Config(retries={"max_attempts": 0}))
    dispatched = False
    try:
        try:
            job = transcribe.get_transcription_job(TranscriptionJobName=job_name)["TranscriptionJob"]
            dispatched = True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "BadRequestException" or "couldn't be found" not in exc.response.get("Error", {}).get("Message", "").lower(): raise
            key = prefix + "input"
            s3.put_object(Bucket=config.media_output_bucket, Key=key, Body=audio, ContentType=mime_type)
            dispatched = True
            job = transcribe.start_transcription_job(TranscriptionJobName=job_name, Media={"MediaFileUri": f"s3://{config.media_output_bucket}/{key}"}, IdentifyLanguage=True, OutputBucketName=config.media_output_bucket, OutputKey=prefix + "transcript.json")["TranscriptionJob"]
        deadline = time.monotonic() + 600
        while job["TranscriptionJobStatus"] in {"QUEUED", "IN_PROGRESS"}:
            if time.monotonic() >= deadline: raise TimeoutError(f"Transcribe job remains resumable: {job_name}")
            time.sleep(5)
            job = transcribe.get_transcription_job(TranscriptionJobName=job_name)["TranscriptionJob"]
        if job["TranscriptionJobStatus"] != "COMPLETED": raise RuntimeError(f"Transcribe failed: {job.get('FailureReason', 'unknown')}")
        result = json.loads(s3.get_object(Bucket=config.media_output_bucket, Key=prefix + "transcript.json")["Body"].read())
        segments = []
        for item in result["results"]["items"]:
            text = item["alternatives"][0]["content"]
            if item["type"] == "punctuation":
                if segments: segments[-1]["text"] += text
                continue
            start, end = float(item["start_time"]), float(item["end_time"])
            if not 0 <= start < end <= duration + 1: raise ValueError("invalid provider word timing")
            segments.append({"id": f"seg-{len(segments)+1}", "startSec": start, "endSec": end, "text": text})
        if not segments: raise ValueError("Transcribe returned no timed words")
        _usage(invocation, "transcriber", model_used(), cost, int(duration + .999), "audio_seconds", usage_reporter)
        return {"language": job.get("LanguageCode", "und"), "segments": segments, "providerOperationId": job_name}
    except Exception:
        _failed(invocation, "transcriber", dispatched, budget_resolver)
        raise

def generate_image(prompt, *, invocation=None, budget_reserver=reserve_budget, budget_resolver=resolve_budget_reservation, usage_reporter=report_usage):
    if invocation is None: raise ValueError("real image generation requires invocation context")
    config = _enabled()
    if not config.generative_media_enabled: raise RuntimeError("generative media disabled")
    cost = config.image_max_cost_usd
    _reserve(invocation, "image_generator", IMAGE_MODEL, cost, budget_reserver)
    dispatched = False
    try:
        client = boto3.client("bedrock-runtime", region_name=config.aws_region, config=Config(retries={"max_attempts": 0}))
        dispatched = True
        response = client.invoke_model(modelId=IMAGE_MODEL, contentType="application/json", accept="application/json", body=json.dumps({"taskType": "TEXT_IMAGE", "textToImageParams": {"text": prompt}, "imageGenerationConfig": {"numberOfImages": 1, "quality": "standard", "height": 1024, "width": 1024}}))
        body = json.loads(response["body"].read())
        if body.get("error") or len(body.get("images", [])) != 1: raise ImageGenError("Nova Canvas returned no single image")
        data = base64.b64decode(body["images"][0], validate=True)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"): raise ImageGenError("Nova Canvas returned malformed PNG")
        _usage(invocation, "image_generator", IMAGE_MODEL, cost, 1, "images", usage_reporter)
        return data, "image/png"
    except Exception as exc:
        _failed(invocation, "image_generator", dispatched, budget_resolver)
        raise ImageGenError(f"image generation failed: {type(exc).__name__}") from exc

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
