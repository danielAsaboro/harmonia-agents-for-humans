"""Harmonia stage handlers: ingest -> transcribe -> understand -> draft -> publish -> verify."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
import secrets
from pathlib import Path
import asyncio
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx
from opentelemetry.trace import Status, StatusCode
from pydantic import ValidationError

from . import clipper, content, x_client, youtube
from .agent_models import (
    AnalysisResult,
    AnalystInput,
    DraftWorkflowInput,
    MediaEvidence,
    StrategistInput,
)
from .agents import (
    AgentProtocolError,
    analyze_with_team,
    configured_memory,
    draft_with_team,
    strategize_with_team,
)
from .config import settings
from .gemma_model import GemmaProtocolError
from .generative_media import (
    LYRIA_MODEL,
    VEO_MODEL,
    GoogleMediaTransport,
    LyriaGenerator,
    MediaProtocolError,
    MediaProviderError,
    VeoGenerator,
)
from .memory_bank import (
    MemoryProtocolError,
    MemoryProviderError,
    eligible_job_memories,
)
from .failures import FailureCategory, FailureEnvelope, normalize_failure
from .team_runtime import AgentEngineProtocolError, AgentEngineProviderError
from .telemetry import current_trace_id, inject_context, safe_attributes, tracer
from .usage import InvocationContext, media_usage_record
from .effect_executor import execute_effect_command, production_adapters
from .web_client import (
    EffectClaimInProgress,
    EffectClaimUncertain,
    WebApiError,
    claim_effect,
    claim_stage_execution,
    finalize_stage_execution,
    get_asset,
    get_connection,
    get_effect_commands,
    get_insights,
    get_job,
    get_media_operation,
    get_chat_attachment,
    post as web_post,
    report_usage,
    reserve_budget,
    resolve_budget_reservation,
    save_media_operation,
)

logger = logging.getLogger("harmonia.stages")
Handler = Callable[[str], Awaitable[None]]


class ClipRenderError(RuntimeError):
    pass


def deterministic_generative_media_actions(job: dict[str, Any]) -> list[dict[str, Any]]:
    """Propose bounded paid media from validated analysis, outside the planner."""
    title = str(job.get("ingestedTitle") or "startup launch")[:200]
    moments = [
        item for item in (job.get("moments") or [])
        if item.get("id") and item.get("visualHook")
    ]
    angles = [item for item in (job.get("angles") or []) if item.get("id")]
    actions: list[dict[str, Any]] = []
    if moments:
        moment = moments[0]
        prompt = (
            f"Vertical cinematic b-roll for {title}. Visual beat: {str(moment['visualHook'])[:500]}. "
            "Abstract product motion, no people, no logos, no text, no dialogue, silent output."
        )
        digest = hashlib.sha256(f"veo|{moment['id']}|{prompt}".encode()).hexdigest()[:12]
        actions.append({
            "id": f"act-veo-{digest}",
            "type": "generate_veo_broll",
            "title": f"Generate Veo b-roll: {str(moment.get('title') or title)[:36]}",
            "description": "Generate one 4-second 720p vertical b-roll asset with Veo 3.1 Fast (estimated $0.08).",
            "momentId": moment["id"],
            "payload": {
                "type": "generate_veo_broll", "prompt": prompt,
                "durationSec": 4, "aspectRatio": "9:16",
            },
        })
    angle = angles[0] if angles else None
    music_concept = str(angle.get("title")) if angle else title
    prompt = (
        f"Instrumental 30-second soundtrack for a startup social clip about {music_concept}. "
        "Optimistic, modern, focused, no vocals, clean ending."
    )
    digest = hashlib.sha256(f"lyria|{music_concept}|{prompt}".encode()).hexdigest()[:12]
    actions.append({
        "id": f"act-lyria-{digest}",
        "type": "generate_lyria_soundtrack",
        "title": f"Generate Lyria soundtrack: {music_concept[:34]}",
        "description": "Generate one 30-second instrumental clip with Lyria 3 (estimated $0.04).",
        **({"angleId": angle["id"]} if angle else {}),
        "payload": {
            "type": "generate_lyria_soundtrack", "prompt": prompt, "durationSec": 30,
        },
    })
    return actions


def _segments_in_window(job: dict[str, Any], start: float, end: float) -> list[dict[str, Any]]:
    """Transcript segments overlapping [start,end], for caption burning."""
    return [
        s for s in (job.get("transcriptSegments") or [])
        if float(s["endSec"]) > start and float(s["startSec"]) < end
    ]


def web_post_raw_asset(job_id: str, action_id: str, mime: str, digest: str, data: bytes) -> None:
    """Uploads binary asset bytes via octet-stream (clips are too big for JSON)."""
    import httpx as _httpx

    cfg = settings()
    url = f"{cfg.web_internal_url}/api/internal/asset"
    headers = {
        "Authorization": f"Bearer {cfg.internal_api_token}",
        "x-job-id": job_id,
        "x-action-id": action_id,
        "x-mime": mime,
        "x-digest": digest,
    }
    inject_context(headers)
    res = _httpx.post(url, content=data, headers=headers, timeout=180)
    if res.status_code >= 300:
        raise WebApiError(f"asset upload failed: {res.status_code} {res.text}", res.status_code)

_AUDIO_CACHE: dict[str, bytes] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _materialize_source_video(job: dict[str, Any], directory: str) -> Path:
    config = job["config"]
    if config.get("youtubeUrl"):
        return clipper.download_video(config["youtubeUrl"], directory)
    attachment_id = config.get("mediaAttachmentId")
    if not attachment_id:
        raise ClipRenderError("job has no renderable media source")
    data, _mime, filename = get_chat_attachment(attachment_id)
    suffix = Path(filename).suffix.lower()
    if suffix not in {".mp4", ".mov", ".webm", ".m4v"}:
        suffix = ".mp4"
    source = Path(directory) / f"source{suffix}"
    source.write_bytes(data)
    return source


async def run_ingest(job_id: str) -> None:
    job = get_job(job_id)
    config = job["config"]
    attachment_id = config.get("mediaAttachmentId")
    if attachment_id:
        audio, mime, filename = get_chat_attachment(attachment_id)
        digest = hashlib.sha256(audio).hexdigest()
        meta = {
            "videoId": attachment_id,
            "title": filename,
            "channel": "operator upload",
            "durationSec": youtube.probe_audio_duration(audio),
        }
        config.setdefault("mediaMime", mime)
    else:
        video_id = youtube.extract_video_id(config["youtubeUrl"])
        meta = youtube.fetch_metadata(video_id)
        audio, digest = youtube.download_audio(config["youtubeUrl"])
    if int(meta.get("durationSec") or 0) <= 0:
        # No Data API key: measure real duration from the downloaded media.
        meta["durationSec"] = youtube.probe_audio_duration(audio)
    web_post("/api/internal/ingest", {
        "jobId": job_id, "stage": "ingest", **meta,
        "mediaBytes": len(audio), "mediaDigest": digest,
    })
    _AUDIO_CACHE[job_id] = audio


async def run_transcribe(job_id: str) -> None:
    job = get_job(job_id)
    config = job["config"]
    attachment_id = config.get("mediaAttachmentId")
    if attachment_id:
        audio = _AUDIO_CACHE.get(job_id) or get_chat_attachment(attachment_id)[0]
        mime = config.get("mediaMime") or "video/mp4"
    else:
        audio = _AUDIO_CACHE.get(job_id) or youtube.download_audio(config["youtubeUrl"])[0]
        mime = "audio/mp4"
    result = content.transcribe_audio(
        audio,
        mime,
        invocation=InvocationContext(
            job_id=job_id,
            workspace_id=job["workspaceId"],
            brand_id=job["brandId"],
            user_id=job["createdByUserId"],
            stage="transcribe", operation_id=f"{job_id}:transcribe:0",
        ),
    )
    web_post("/api/internal/transcript", {
        "jobId": job_id, "stage": "transcribe",
        "language": result.get("language", "en"),
        "segments": result["segments"], "modelUsed": content.model_used(),
    })


async def run_understand(job_id: str) -> None:
    job = get_job(job_id)
    invocation = InvocationContext(
        job_id=job_id,
        workspace_id=job["workspaceId"],
        brand_id=job["brandId"],
        user_id=job["createdByUserId"],
        stage="understand", operation_id=f"{job_id}:understand:0",
    )
    prior = ""
    try:
        insights = get_insights()
        if insights.get("totals", {}).get("posts"):
            top = insights["topPosts"][:3]
            lines = [f"- {p['likes']} likes, {p['reposts']} reposts: \"{p['text'][:120]}\"" for p in top]
            prior = "\n".join(lines)
        goals = insights.get("goals") or {}
        goal_bits: list[str] = []
        if goals.get("weeklyPostTarget"):
            goal_bits.append(f"posting target: {goals['weeklyPostTarget']} posts/week")
        if goals.get("audience"):
            goal_bits.append(f"audience: {goals['audience']}")
        if goals.get("voice"):
            goal_bits.append(f"brand voice: {goals['voice']}")
        for t in (goals.get("topics") or [])[:5]:
            goal_bits.append(f"priority topic: {t}")
        if goal_bits:
            prior = ("Operator goals: " + "; ".join(goal_bits) + "\n" + prior).strip()
    except WebApiError:
        logger.info("no prior engagement insights yet")
    if not job["transcriptSegments"]:
        brief = (job.get("config") or {}).get("brief")
        if not brief:
            raise RuntimeError("job has neither transcript nor operator brief")
        strategy = await strategize_with_team(StrategistInput(
            task="brief", brief=brief, prior_learnings=prior,
        ), invocation=invocation)
        if strategy.analysis is None:
            raise AgentProtocolError("strategist brief task returned no analysis")
        result = strategy.analysis.model_dump(mode="json")
    else:
        transcript = "\n".join(
            f"[{int(s['startSec'])}s] {s['text']}" for s in job["transcriptSegments"]
        )
        media_evidence = None
        source_url = (job.get("config") or {}).get("youtubeUrl") or (job.get("config") or {}).get("mediaStorageUri")
        source_digest = job.get("mediaDigest")
        duration = job.get("ingestedDurationSec")
        if source_url and source_digest and duration:
            media_evidence = MediaEvidence(
                video_uri=source_url,
                duration_sec=duration,
                source_digest=source_digest,
                frames=[],
            )
        result = (await analyze_with_team(AnalystInput(
            title=job["ingestedTitle"],
            channel=job["ingestedChannel"],
            transcript=transcript,
            prior_learnings=prior,
            media_evidence=media_evidence,
        ), invocation=invocation)).model_dump(mode="json")
    web_post("/api/internal/analysis", {
        "jobId": job_id, "stage": "understand",
        "moments": result.get("moments", [])[:12],
        "angles": result.get("angles", [])[:12],
        "summary": result.get("summary", ""),
        "modelUsed": content.model_used(),
    })


async def run_draft(job_id: str) -> None:
    job = get_job(job_id)
    analysis = AnalysisResult.model_validate({
        "summary": job.get("summary") or "Content analysis completed.",
        "moments": job["moments"],
        "angles": job["angles"],
    })
    brand_context = ""
    try:
        insights = get_insights()
        brand_context = json.dumps({
            "goals": insights.get("goals") or {},
            "topPosts": (insights.get("topPosts") or [])[:3],
        })[:4000]
    except WebApiError:
        logger.info("draft workflow has no brand goals or engagement context yet")
    package = await draft_with_team(DraftWorkflowInput(
        title=job["ingestedTitle"], analysis=analysis, brand_context=brand_context,
    ), invocation=InvocationContext(
        job_id=job_id,
        workspace_id=job["workspaceId"],
        brand_id=job["brandId"],
        user_id=job["createdByUserId"],
        stage="draft", operation_id=f"{job_id}:draft:0",
    ))
    drafts = package.reviewed_drafts.model_dump(mode="json")["drafts"]
    plan = package.action_plan.model_dump(mode="json")

    def clean(a: dict) -> dict | None:
        if a.get("type") == "publish_x_post" and a.get("text"):
            return {
                "id": f"act-{hashlib.sha256(a['text'].encode()).hexdigest()[:12]}",
                "type": "publish_x_post", "title": a["text"][:48],
                "description": "Publish drafted post to X after operator approval.",
                "payload": {"type": "publish_x_post", "text": a["text"]},
            }
        return None

    actions = [c for c in (clean(a) for a in plan.get("actions", [])) if c]
    actions.append({
        "id": "act-content-pack", "type": "export_content_pack",
        "title": "Assemble content pack",
        "description": "Bundle moments, angles and drafts into an exportable markdown pack.",
        "payload": {"type": "export_content_pack"},
    })

    # Propose image assets for the top meme angles (capped to bound cost).
    meme_angles = [a for a in (job.get("angles") or []) if a.get("kind") == "meme"]
    for angle in meme_angles[:2]:
        prompt_text = (
            f"Social media meme image for a startup. Concept: {angle['title']}. "
            f"Rationale: {angle['rationale']}. Context: {job['ingestedTitle']}. "
            "Clean, shareable, platform-friendly composition, no text artifacts or watermarks."
        )
        aid = f"act-img-{hashlib.sha256(prompt_text.encode()).hexdigest()[:12]}"
        actions.append({
            "id": aid, "type": "generate_image",
            "title": f"Generate meme image: {angle['title'][:40]}",
            "description": "Generates an internal image asset with Gemini; review before any use.",
            "angleId": angle["id"],
            "payload": {"type": "generate_image", "prompt": prompt_text},
        })

    # Propose captioned vertical clips from the strongest moments (video jobs only).
    moments = [m for m in (job.get("moments") or []) if m.get("endSec", 0) > m.get("startSec", 0)]
    if job["config"].get("youtubeUrl"):
        for moment in moments[:2]:
            cid = f"act-clip-{hashlib.sha256(moment['id'].encode()).hexdigest()[:12]}"
            actions.append({
                "id": cid, "type": "render_clip",
                "title": f"Cut clip: {moment['title'][:40]}",
                "description": "Renders a captioned vertical short from this moment with ffmpeg; internal asset.",
                "momentId": moment["id"],
                "payload": {"type": "render_clip", "momentId": moment["id"], "format": "vertical", "captions": True},
            })
        if len(moments) >= 2:
            actions.append({
                "id": "act-reel-top2",
                "type": "render_reel",
                "title": "Stitch highlight reel (top 2 moments)",
                "description": "Concatenates the top moments into one vertical reel with ffmpeg; internal asset.",
                "payload": {
                    "type": "render_reel",
                    "momentIds": [m["id"] for m in moments[:2]],
                    "format": "vertical",
                    "captions": True,
                },
            })

    if settings().generative_media_enabled:
        actions.extend(deterministic_generative_media_actions(job))

    web_post("/api/internal/drafts", {
        "jobId": job_id, "stage": "draft", "drafts": drafts,
        "proposedActions": actions,
    })


def _idempotency_key(job_id: str, action: dict) -> str:
    material = json.dumps({"j": job_id, "a": action["id"], "p": action["payload"]}, sort_keys=True)
    return hashlib.sha256(material.encode()).hexdigest()


def _receipts_for_job(job_id: str) -> list[dict[str, Any]]:
    from .web_client import _client

    with _client() as c:
        res = c.get(f"/api/internal/job/{job_id}/receipts")
    if res.status_code != 200:
        return []
    return res.json().get("receipts", [])


async def run_publish(job_id: str) -> None:
    job = get_job(job_id)
    commands = [
        command for command in get_effect_commands(job_id)
        if command.get("state") in ("pending", "claimed")
    ]
    done_keys = {
        r["idempotencyKey"] for r in _receipts_for_job(job_id)
        if r["outcome"] in ("applied", "already_applied")
    }

    for command in commands:
        action = {
            "id": command["actionId"],
            "type": command["actionType"],
            "payload": command["payload"],
        }
        key = command["payloadDigest"]
        if action["type"] == "publish_x_post":
            connection = get_connection("x")
            result = execute_effect_command(
                command,
                adapters=production_adapters(str(connection.get("accessToken") or "")),
            )
            if result.outcome == "in_progress":
                raise EffectClaimInProgress("another worker currently owns this effect")
            if result.outcome == "uncertain":
                raise EffectClaimUncertain("a prior effect attempt has no final receipt")
            continue
        trace_id = current_trace_id()
        operation_id = f"{job_id}:publish:{action['id']}:{trace_id}"
        claim_token = uuid.uuid4().hex
        claim_result = claim_effect({
            "commandId": command["id"],
            "jobId": job_id, "actionId": action["id"], "actionType": action["type"],
            "idempotencyKey": key, "operationId": operation_id,
            "traceId": trace_id, "claimToken": claim_token,
        })
        if claim_result["outcome"] == "already_applied":
            continue
        if claim_result["outcome"] == "in_progress":
            raise EffectClaimInProgress("another worker currently owns this effect")
        if claim_result["outcome"] == "uncertain":
            raise EffectClaimUncertain("a prior effect attempt has no final receipt")
        detail: dict[str, Any] = {"idempotencyKey": key}
        outcome, artifact = "failed", None
        budget_operation_id: str | None = None
        budget_dispatched = False
        try:
            if action["type"] == "export_content_pack":
                pack = content.build_content_pack(
                    job.get("ingestedTitle", ""),
                    job["config"].get("youtubeUrl") or "operator brief",
                    job.get("moments", []), job.get("angles", []), job.get("drafts", []),
                )
                digest = hashlib.sha256(pack.encode()).hexdigest()
                web_post("/api/internal/pack", {"jobId": job_id, "markdown": pack, "digest": digest})
                outcome = "already_applied" if key in done_keys else "applied"
                artifact = {
                    "kind": "firestore_doc",
                    "url": f"{os.environ.get('WEB_INTERNAL_URL', '')}/api/internal/job/{job_id}",
                    "fetchedAt": _now(), "digest": digest,
                }
                detail["digest"] = digest
            elif action["type"] == "generate_image":
                if key in done_keys:
                    outcome, detail["note"] = "already_applied", "receipt exists; skipped"
                else:
                    img_bytes, mime = content.generate_image(
                        action["payload"]["prompt"],
                        invocation=InvocationContext(
                            job_id=job_id,
                            workspace_id=job["workspaceId"],
                            brand_id=job["brandId"],
                            user_id=job["createdByUserId"],
                            stage="publish",
                            operation_id=f"{job_id}:publish:{action['id']}",
                        ),
                    )
                    digest = hashlib.sha256(img_bytes).hexdigest()
                    import base64

                    web_post("/api/internal/asset", {
                        "jobId": job_id, "actionId": action["id"], "mime": mime,
                        "dataBase64": base64.b64encode(img_bytes).decode(),
                        "digest": digest,
                    })
                    outcome = "applied"
                    artifact = {
                        "kind": "asset_store",
                        "url": f"/api/jobs/{job_id}/assets/{action['id']}",
                        "fetchedAt": _now(), "digest": digest,
                    }
                    detail.update({"digest": digest, "mime": mime, "bytes": len(img_bytes)})
            elif action["type"] in ("generate_veo_broll", "generate_lyria_soundtrack"):
                if key in done_keys:
                    outcome, detail["note"] = "already_applied", "receipt exists; skipped"
                else:
                    cfg = settings()
                    payload = action["payload"]
                    model_id = VEO_MODEL if action["type"] == "generate_veo_broll" else LYRIA_MODEL
                    cost = "0.080000" if action["type"] == "generate_veo_broll" else "0.040000"
                    role = "veo_generator" if action["type"] == "generate_veo_broll" else "lyria_generator"
                    invocation = InvocationContext(
                        job_id=job_id,
                        workspace_id=job["workspaceId"],
                        brand_id=job["brandId"],
                        user_id=job["createdByUserId"],
                        stage="publish",
                        operation_id=f"{job_id}:publish:{action['id']}",
                    )
                    reserve_budget({
                        "jobId": job_id,
                        "operationId": invocation.operation_id,
                        "stage": "publish",
                        "role": role,
                        "model": model_id,
                        "estimatedCostUsd": cost,
                        "pricingVersion": "2026-08-23",
                    })
                    budget_operation_id = invocation.operation_id
                    recorded = get_media_operation(job_id, action["id"])
                    existing_asset = get_asset(job_id, action["id"])
                    if recorded is not None and existing_asset is not None:
                        budget_dispatched = True
                        report_usage(media_usage_record(
                            invocation=invocation,
                            role=role,
                            model=model_id,
                            estimated_cost_usd=cost,
                            trace_id=current_trace_id(),
                        ).to_wire())
                        budget_operation_id = None
                        outcome = "already_applied"
                        digest = str(existing_asset["digest"])
                        artifact = {
                            "kind": "asset_store",
                            "url": f"/api/jobs/{job_id}/assets/{action['id']}",
                            "fetchedAt": _now(), "digest": digest,
                        }
                        detail.update({
                            "digest": digest,
                            "mime": existing_asset["mime"],
                            "model": model_id,
                            "providerOperation": recorded["operationName"],
                            "note": "persisted provider operation and asset already exist",
                        })
                        web_post("/api/internal/receipt", {
                            "commandId": command["id"],
                            "jobId": job_id, "actionId": action["id"],
                            "actionType": action["type"], "idempotencyKey": key,
                            "operationId": operation_id,
                            "traceId": trace_id, "claimToken": claim_token,
                            "outcome": outcome, "artifact": artifact, "detail": detail,
                        })
                        continue
                    transport = GoogleMediaTransport(
                        project=cfg.gcp_project, location=cfg.vertex_media_location,
                    )
                    budget_dispatched = recorded is not None
                    if action["type"] == "generate_veo_broll":
                        budget_dispatched = True
                        generated = VeoGenerator(transport=transport).generate(
                            prompt=payload["prompt"],
                            duration_sec=int(payload["durationSec"]),
                            aspect_ratio=payload["aspectRatio"],
                            existing_operation=(recorded or {}).get("operationName"),
                            persist_operation=lambda operation_name: save_media_operation(
                                job_id, action["id"], "veo", operation_name,
                            ),
                        )
                    else:
                        budget_dispatched = True
                        generated = LyriaGenerator(transport=transport).generate(
                            prompt=payload["prompt"],
                            duration_sec=int(payload["durationSec"]),
                        )
                        save_media_operation(
                            job_id, action["id"], "lyria", generated.provider_id,
                        )
                    digest = hashlib.sha256(generated.data).hexdigest()
                    web_post_raw_asset(
                        job_id, action["id"], generated.mime, digest, generated.data,
                    )
                    report_usage(media_usage_record(
                        invocation=invocation,
                        role=role,
                        model=generated.model,
                        estimated_cost_usd=generated.estimated_cost_usd,
                        trace_id=current_trace_id(),
                    ).to_wire())
                    budget_operation_id = None
                    outcome = "applied"
                    artifact = {
                        "kind": "asset_store",
                        "url": f"/api/jobs/{job_id}/assets/{action['id']}",
                        "fetchedAt": _now(), "digest": digest,
                    }
                    detail.update({
                        "digest": digest,
                        "mime": generated.mime,
                        "bytes": len(generated.data),
                        "model": generated.model,
                        "providerOperation": generated.provider_id,
                        "durationSec": generated.duration_sec,
                    })
            elif action["type"] in ("render_clip", "render_reel"):
                if key in done_keys:
                    outcome, detail["note"] = "already_applied", "receipt exists; skipped"
                else:
                    outcome = "applied"
                    import tempfile
                    from pathlib import Path

                    fmt = action["payload"].get("format", "vertical")
                    want_caps = action["payload"].get("captions", True)
                    render_notes: list[str] = []
                    with tempfile.TemporaryDirectory() as td:
                        src = _materialize_source_video(job, td)
                        if action["type"] == "render_clip":
                            moment = next(
                                (m for m in job.get("moments", []) if m["id"] == action["payload"]["momentId"]),
                                None,
                            )
                            if not moment:
                                raise ClipRenderError("moment referenced by render_clip no longer exists")
                            out = Path(td) / "clip.mp4"
                            render_notes += clipper.render_clip(
                                src, out,
                                float(moment["startSec"]), float(moment["endSec"]),
                                fmt=fmt,
                                captions=_segments_in_window(job, float(moment["startSec"]), float(moment["endSec"])) if want_caps else None,
                            )
                        else:
                            parts: list[Path] = []
                            for i, mid in enumerate(action["payload"]["momentIds"]):
                                m = next((m for m in job.get("moments", []) if m["id"] == mid), None)
                                if not m:
                                    raise ClipRenderError(f"moment {mid} no longer exists")
                                part = Path(td) / f"part{i}.mp4"
                                render_notes += clipper.render_clip(
                                    src, part,
                                    float(m["startSec"]), float(m["endSec"]),
                                    fmt=fmt,
                                    captions=_segments_in_window(job, float(m["startSec"]), float(m["endSec"])) if want_caps else None,
                                )
                                parts.append(part)
                            out = Path(td) / "reel.mp4"
                            clipper.render_reel(parts, out)
                        video_bytes = out.read_bytes()

                    digest = hashlib.sha256(video_bytes).hexdigest()
                    web_post_raw_asset(
                        job_id, action["id"], "video/mp4", digest, video_bytes,
                    )
                    artifact = {
                        "kind": "asset_store",
                        "url": f"/api/jobs/{job_id}/assets/{action['id']}",
                        "fetchedAt": _now(), "digest": digest,
                    }
                    detail.update({
                        "digest": digest, "mime": "video/mp4",
                        "bytes": len(video_bytes), "format": fmt,
                        **({"notes": render_notes} if render_notes else {}),
                    })
        except (x_client.XError, content.ImageGenError, ClipRenderError) as exc:
            outcome, detail["error"] = "failed", str(exc)
        except Exception:
            if budget_operation_id is not None:
                try:
                    resolve_budget_reservation({
                        "jobId": job_id,
                        "operationId": budget_operation_id,
                        "outcome": "uncertain" if budget_dispatched else "not_invoked",
                        "reason": (
                            "paid media failed after provider dispatch"
                            if budget_dispatched else "paid media failed before provider dispatch"
                        ),
                    })
                except Exception:  # noqa: BLE001 - preserve the causal provider failure
                    logger.exception(
                        "budget resolution failed for operation %s", budget_operation_id,
                    )
            raise

        web_post("/api/internal/receipt", {
            "commandId": command["id"],
            "jobId": job_id, "actionId": action["id"], "actionType": action["type"],
            "idempotencyKey": key,
            "operationId": operation_id,
            "traceId": trace_id, "claimToken": claim_token, "outcome": outcome,
            "artifact": artifact, "detail": detail,
        })

    refreshed = get_job(job_id)
    if refreshed["stage"] == "publish":
        web_post(f"/api/internal/publish/{job_id}/complete", {"stage": "publish"})


async def run_verify(job_id: str) -> None:
    job = get_job(job_id)
    receipts = _receipts_for_job(job_id)
    receipt_by_action = {r["actionId"]: r for r in receipts}
    results: list[dict[str, Any]] = []
    trace_id = current_trace_id()

    for action in job.get("actions", []):
        if action.get("state") != "executed":
            continue
        receipt = receipt_by_action.get(action["id"])
        if not receipt:
            raise RuntimeError(f"executed action {action['id']} has no durable receipt")
        detail = receipt.get("detail", {})
        lineage = {
            "receiptId": receipt["id"],
            "operationId": f"{job_id}:verify:{action['id']}",
            "traceId": trace_id,
        }
        if action["type"] == "publish_x_post" and detail.get("id"):
            connection = get_connection("x")
            post = x_client.get_post(str(detail["id"]), connection.get("accessToken"))
            observed_digest = hashlib.sha256(str(post.get("text", "")).encode()).hexdigest() if post else None
            results.append({
                "target": f"x:{detail['id']}", "actionId": action["id"],
                "verified": bool(post),
                "method": "official_api_readback", **lineage,
                "evidence": {"kind": "x_api", "url": detail.get("url", ""), "fetchedAt": _now(), "digest": observed_digest},
                "note": "re-fetched from X API" if post else "tweet not found on refetch",
            })
        elif action["type"] == "export_content_pack" and job.get("contentPack"):
            expected, actual = detail.get("digest", ""), job["contentPack"]["digest"]
            results.append({
                "target": "content-pack", "actionId": action["id"],
                "verified": bool(expected and actual == expected),
                "method": "artifact_digest_reread", **lineage,
                "evidence": {"kind": "firestore_doc", "url": "", "fetchedAt": _now(), "digest": actual},
                "note": "pack digest matches receipt" if expected == actual else "pack digest mismatch",
            })
        elif action["type"] in (
            "generate_image", "generate_veo_broll", "generate_lyria_soundtrack",
            "render_clip", "render_reel",
        ) and detail.get("digest"):
            stored = get_asset(job_id, action["id"])
            actual = (stored or {}).get("digest", "")
            results.append({
                "target": f"asset:{action['id']}", "actionId": action["id"],
                "verified": bool(stored) and actual == detail["digest"],
                "method": "artifact_digest_reread", **lineage,
                "evidence": {
                    "kind": "asset_store",
                    "url": f"/api/jobs/{job_id}/assets/{action['id']}",
                    "fetchedAt": _now(), "digest": actual,
                },
                "note": "stored asset digest matches receipt" if stored else "asset missing from store",
            })

    web_post("/api/internal/verification", {"jobId": job_id, "results": results})


async def run_learn(job_id: str) -> None:
    """Closes the loop: measure published posts, derive takeaways, complete job."""
    job = get_job(job_id)
    receipts = _receipts_for_job(job_id)
    receipt_by_action = {r["actionId"]: r for r in receipts}

    engagement: list[dict[str, Any]] = []
    for action in job.get("actions", []):
        if action.get("type") != "publish_x_post" or action.get("state") != "executed":
            continue
        post_id = receipt_by_action.get(action["id"], {}).get("detail", {}).get("id")
        if not post_id:
            continue
        connection = get_connection("x")
        metrics = x_client.get_post_metrics(str(post_id), connection.get("accessToken"))
        if not metrics:
            continue
        engagement.append({
            "actionId": action["id"],
            "postId": str(post_id),
            **metrics,
        })

    notes: list[str] = []
    if engagement:
        best = max(engagement, key=lambda e: (e["likes"], e["reposts"]))
        draft_text = next(
            (
                a["payload"].get("text", "")
                for a in job.get("actions", [])
                if a["id"] == best["actionId"]
            ),
            "",
        )
        notes.append(f"top post earned {best['likes']} likes / {best['reposts']} reposts")
        if draft_text:
            notes.append(f"winning pattern to double down on: \"{draft_text[:160]}\"")
    else:
        notes.append("no published posts measured yet (X publishing optional)")

    summary = (
        f"{len(engagement)} published post(s) measured; "
        + (notes[0] if engagement else "insights will accrue as posts publish.")
    )
    memory = configured_memory(InvocationContext(
        job_id=job_id,
        workspace_id=job["workspaceId"],
        brand_id=job["brandId"],
        user_id=job["createdByUserId"],
        stage="learn",
        operation_id=f"{job_id}:learn:0",
    ))
    if memory is not None:
        bank, scope = memory
        candidates = eligible_job_memories(job, measured_posts=len(engagement))
        await asyncio.to_thread(bank.generate, scope=scope, candidates=candidates)
    web_post("/api/internal/engagement", {
        "jobId": job_id,
        "stage": "learn",
        "engagement": engagement,
        "learnings": {"summary": summary, "notes": notes},
    })


HANDLERS: dict[str, Handler] = {
    "ingest": run_ingest,
    "transcribe": run_transcribe,
    "understand": run_understand,
    "draft": run_draft,
    "publish": run_publish,
    "verify": run_verify,
    "learn": run_learn,
}


def classify_failure(exc: Exception) -> bool:
    """Compatibility view: True means acknowledge instead of retrying."""
    envelope = normalize_failure(
        exc,
        stage="unknown",
        operation_id="compatibility:unknown:0",
        trace_id="0" * 32,
        attempt=0,
    )
    return not envelope.retryable


def _failure_payload(job_id: str, envelope: FailureEnvelope) -> dict[str, object]:
    return {
        "jobId": job_id,
        "stage": envelope.stage,
        "category": envelope.category.value,
        "code": envelope.code,
        "publicMessage": envelope.public_message,
        "retryable": envelope.retryable,
        "operationId": envelope.operation_id,
        "traceId": envelope.trace_id,
        "attempt": envelope.attempt,
        "maxAttempts": envelope.max_attempts,
        "details": envelope.details,
    }


async def dispatch(job_id: str, stage: str, *, attempt: int = 0) -> bool:
    with tracer().start_as_current_span("harmonia.stage.execute") as span:
        span.set_attributes(safe_attributes({
            "job.id": job_id,
            "stage": stage,
            "attempt": attempt,
        }))
        handler = HANDLERS.get(stage)
        if handler is None:
            envelope = normalize_failure(
                RuntimeError("stage handler is missing"),
                stage=stage,
                operation_id=f"{job_id}:{stage}:{attempt}",
                trace_id=current_trace_id(),
                attempt=attempt,
                category=FailureCategory.PROTOCOL,
                code="missing_stage_handler",
            )
            span.set_status(Status(StatusCode.ERROR, envelope.code))
            web_post("/api/internal/failure", _failure_payload(job_id, envelope))
            return True
        claim_token = secrets.token_urlsafe(32)
        claim = claim_stage_execution({
            "jobId": job_id,
            "stage": stage,
            "ownerId": f"worker:{os.getpid()}",
            "claimToken": claim_token,
        })
        if claim["outcome"] != "execute":
            span.set_attributes(safe_attributes({"stage.claim_outcome": claim["outcome"]}))
            return True
        try:
            await handler(job_id)
            finalize_stage_execution({
                "jobId": job_id,
                "stage": stage,
                "claimToken": claim_token,
                "outcome": "applied",
            })
            return True
        except Exception as exc:  # noqa: BLE001 - classified then reported
            envelope = normalize_failure(
                exc,
                stage=stage,
                operation_id=f"{job_id}:{stage}:{attempt}",
                trace_id=current_trace_id(),
                attempt=attempt,
            )
            span.set_attributes(safe_attributes({
                "failure.category": envelope.category.value,
                "failure.code": envelope.code,
                "failure.retryable": envelope.retryable,
            }))
            span.set_status(Status(StatusCode.ERROR, envelope.code))
            logger.error(
                "stage %s failed for %s (%s/%s retryable=%s)",
                stage, job_id, envelope.category.value, envelope.code, envelope.retryable,
            )
            try:
                web_post("/api/internal/failure", _failure_payload(job_id, envelope))
            except Exception:  # noqa: BLE001
                logger.exception("failure reporting also failed")
            try:
                finalize_stage_execution({
                    "jobId": job_id,
                    "stage": stage,
                    "claimToken": claim_token,
                    "outcome": "failed" if not envelope.retryable else "uncertain",
                    "failureReason": envelope.code,
                })
            except Exception:  # noqa: BLE001
                logger.exception("stage claim finalization also failed")
            return True
