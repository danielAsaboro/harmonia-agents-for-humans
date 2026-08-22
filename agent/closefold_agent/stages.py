"""Harmonia stage handlers: ingest -> transcribe -> understand -> draft -> publish -> verify."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

from . import content, x_client, youtube
from .agents import plan_agent, run_structured
from .web_client import WebApiError, get_job, post as web_post

logger = logging.getLogger("harmonia.stages")
Handler = Callable[[str], Awaitable[None]]

_AUDIO_CACHE: dict[str, bytes] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def run_ingest(job_id: str) -> None:
    job = get_job(job_id)
    video_id = youtube.extract_video_id(job["config"]["youtubeUrl"])
    meta = youtube.fetch_metadata(video_id)
    audio, digest = youtube.download_audio(job["config"]["youtubeUrl"])
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
        "segments": result["segments"], "modelUsed": content.MODEL,
    })


async def run_understand(job_id: str) -> None:
    job = get_job(job_id)
    transcript = "\n".join(
        f"[{int(s['startSec'])}s] {s['text']}" for s in job["transcriptSegments"]
    )
    result = content.analyze(job["ingestedTitle"], job["ingestedChannel"], transcript)
    web_post("/api/internal/analysis", {
        "jobId": job_id, "stage": "understand",
        "moments": result.get("moments", [])[:12],
        "angles": result.get("angles", [])[:12],
        "summary": result.get("summary", ""),
        "modelUsed": content.MODEL,
    })


async def run_draft(job_id: str) -> None:
    job = get_job(job_id)
    analysis = {"moments": job["moments"], "angles": job["angles"]}
    drafts = content.draft_posts(job["ingestedTitle"], analysis)[:10]

    prompt = (
        f"Analysis: {json.dumps(analysis)[:20000]}\nDrafts: {json.dumps(drafts)[:20000]}\n\n"
        "Produce the actions JSON per your instructions."
    )
    plan = await run_structured(plan_agent(), prompt)

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
                    job.get("ingestedTitle", ""), job["config"]["youtubeUrl"],
                    job.get("moments", []), job.get("angles", []), job.get("drafts", []),
                )
                digest = hashlib.sha256(pack.encode()).hexdigest()
                web_post("/api/internal/pack", {"jobId": job_id, "markdown": pack, "digest": digest})
                outcome = "already_applied" if key in done_keys else "applied"
                artifact = {"kind": "firestore_doc", "url": f"{os.environ.get('WEB_INTERNAL_URL', '')}/api/internal/job/{job_id}", "fetchedAt": _now()}
                detail["digest"] = digest
        except x_client.XError as exc:
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

    web_post("/api/internal/verification", {"jobId": job_id, "results": results})


HANDLERS: dict[str, Handler] = {
    "ingest": run_ingest,
    "transcribe": run_transcribe,
    "understand": run_understand,
    "draft": run_draft,
    "publish": run_publish,
    "verify": run_verify,
}


def classify_failure(exc: Exception) -> bool:
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


async def dispatch(job_id: str, stage: str) -> bool:
    handler = HANDLERS.get(stage)
    if handler is None:
        web_post("/api/internal/failure", {"jobId": job_id, "stage": stage, "error": f"no handler for stage '{stage}'", "permanent": True})
        return True
    try:
        await handler(job_id)
        return True
    except Exception as exc:  # noqa: BLE001 - classified then reported
        permanent = classify_failure(exc)
        logger.exception("stage %s failed for %s (permanent=%s)", stage, job_id, permanent)
        try:
            web_post("/api/internal/failure", {"jobId": job_id, "stage": stage, "error": f"{type(exc).__name__}: {exc}", "permanent": permanent})
        except Exception:  # noqa: BLE001
            logger.exception("failure reporting also failed")
        return permanent
