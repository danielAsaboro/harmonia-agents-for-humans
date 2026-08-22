"""Harmonia stage handlers: ingest -> transcribe -> understand -> draft -> publish -> verify."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx
from opentelemetry.trace import Status, StatusCode
from pydantic import ValidationError

from . import clipper, content, x_client, youtube
from .agent_models import AnalysisResult, AnalystInput, DraftWorkflowInput, StrategistInput
from .agents import AgentProtocolError, analyze_with_team, draft_with_team, strategize_with_team
from .config import settings
from .telemetry import inject_context, safe_attributes, tracer
from .web_client import WebApiError, get_asset, get_insights, get_job, post as web_post

logger = logging.getLogger("harmonia.stages")
Handler = Callable[[str], Awaitable[None]]


class ClipRenderError(RuntimeError):
    pass


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


async def run_ingest(job_id: str) -> None:
    job = get_job(job_id)
    video_id = youtube.extract_video_id(job["config"]["youtubeUrl"])
    meta = youtube.fetch_metadata(video_id)
    audio, digest = youtube.download_audio(job["config"]["youtubeUrl"])
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
    audio = _AUDIO_CACHE.get(job_id) or youtube.download_audio(job["config"]["youtubeUrl"])[0]
    result = content.transcribe_audio(audio, "audio/mp4")
    web_post("/api/internal/transcript", {
        "jobId": job_id, "stage": "transcribe",
        "language": result.get("language", "en"),
        "segments": result["segments"], "modelUsed": content.model_used(),
    })


async def run_understand(job_id: str) -> None:
    job = get_job(job_id)
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
        ))
        if strategy.analysis is None:
            raise AgentProtocolError("strategist brief task returned no analysis")
        result = strategy.analysis.model_dump(mode="json")
    else:
        transcript = "\n".join(
            f"[{int(s['startSec'])}s] {s['text']}" for s in job["transcriptSegments"]
        )
        result = (await analyze_with_team(AnalystInput(
            title=job["ingestedTitle"],
            channel=job["ingestedChannel"],
            transcript=transcript,
            prior_learnings=prior,
        ))).model_dump(mode="json")
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
    executable = [
        a for a in job.get("actions", [])
        if a.get("state") == "planned"
        and (not a.get("requiresApproval") or a.get("approvalState") == "approved")
    ]
    done_keys = {
        r["idempotencyKey"] for r in _receipts_for_job(job_id)
        if r["outcome"] in ("applied", "already_applied")
    }

    for action in executable:
        key = _idempotency_key(job_id, action)
        detail: dict[str, Any] = {"idempotencyKey": key}
        outcome, artifact = "failed", None
        try:
            if action["type"] == "publish_x_post":
                if key in done_keys:
                    outcome, detail["note"] = "already_applied", "receipt exists; skipped"
                else:
                    posted = x_client.publish_post(action["payload"]["text"])
                    outcome = "applied"
                    artifact = {"kind": "x_api", "url": posted["url"], "fetchedAt": _now()}
                    detail.update(posted)
            elif action["type"] == "export_content_pack":
                pack = content.build_content_pack(
                    job.get("ingestedTitle", ""),
                    job["config"].get("youtubeUrl") or "operator brief",
                    job.get("moments", []), job.get("angles", []), job.get("drafts", []),
                )
                digest = hashlib.sha256(pack.encode()).hexdigest()
                web_post("/api/internal/pack", {"jobId": job_id, "markdown": pack, "digest": digest})
                outcome = "already_applied" if key in done_keys else "applied"
                artifact = {"kind": "firestore_doc", "url": f"{os.environ.get('WEB_INTERNAL_URL', '')}/api/internal/job/{job_id}", "fetchedAt": _now()}
                detail["digest"] = digest
            elif action["type"] == "generate_image":
                if key in done_keys:
                    outcome, detail["note"] = "already_applied", "receipt exists; skipped"
                else:
                    img_bytes, mime = content.generate_image(action["payload"]["prompt"])
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
                        src = clipper.download_video(job["config"]["youtubeUrl"], td)
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

        web_post("/api/internal/receipt", {
            "jobId": job_id, "actionId": action["id"], "actionType": action["type"],
            "idempotencyKey": key, "outcome": outcome,
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

    for action in job.get("actions", []):
        if action.get("state") != "executed":
            continue
        detail = receipt_by_action.get(action["id"], {}).get("detail", {})
        if action["type"] == "publish_x_post" and detail.get("id"):
            post = x_client.get_post(str(detail["id"]))
            results.append({
                "target": f"x:{detail['id']}", "actionId": action["id"],
                "verified": bool(post),
                "method": "independent_refetch:x_api",
                "evidence": {"kind": "x_api", "url": detail.get("url", ""), "fetchedAt": _now()},
                "note": "re-fetched from X API" if post else "tweet not found on refetch",
            })
        elif action["type"] == "export_content_pack" and job.get("contentPack"):
            expected, actual = detail.get("digest", ""), job["contentPack"]["digest"]
            results.append({
                "target": "content-pack", "actionId": action["id"],
                "verified": bool(expected and actual == expected),
                "method": "independent_refetch:firestore_doc",
                "evidence": {"kind": "firestore_doc", "url": "", "fetchedAt": _now(), "digest": actual},
                "note": "pack digest matches receipt" if expected == actual else "pack digest mismatch",
            })
        elif action["type"] in ("generate_image", "render_clip", "render_reel") and detail.get("digest"):
            stored = get_asset(job_id, action["id"])
            actual = (stored or {}).get("digest", "")
            results.append({
                "target": f"asset:{action['id']}", "actionId": action["id"],
                "verified": bool(stored) and actual == detail["digest"],
                "method": "independent_refetch:asset_store",
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
        metrics = x_client.get_post_metrics(str(post_id))
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
    if isinstance(exc, (AgentProtocolError, ValidationError)):
        return True
    if isinstance(exc, WebApiError):
        return exc.permanent
    if isinstance(exc, x_client.XError):
        return exc.permanent
    if isinstance(exc, youtube.IngestError):
        return True
    if isinstance(exc, httpx.HTTPError):
        return False
    if isinstance(exc, KeyError):
        return True
    return False


async def dispatch(job_id: str, stage: str, *, attempt: int = 0) -> bool:
    with tracer().start_as_current_span("harmonia.stage.execute") as span:
        span.set_attributes(safe_attributes({
            "job.id": job_id,
            "stage": stage,
            "attempt": attempt,
        }))
        handler = HANDLERS.get(stage)
        if handler is None:
            error = f"no handler for stage '{stage}'"
            span.set_status(Status(StatusCode.ERROR, error))
            web_post("/api/internal/failure", {
                "jobId": job_id, "stage": stage, "error": error, "permanent": True,
            })
            return True
        try:
            await handler(job_id)
            return True
        except Exception as exc:  # noqa: BLE001 - classified then reported
            permanent = classify_failure(exc)
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
            logger.exception("stage %s failed for %s (permanent=%s)", stage, job_id, permanent)
            try:
                web_post("/api/internal/failure", {
                    "jobId": job_id, "stage": stage,
                    "error": f"{type(exc).__name__}: {exc}", "permanent": permanent,
                })
            except Exception:  # noqa: BLE001
                logger.exception("failure reporting also failed")
            return permanent
