"""Stage handlers: one handler per Pub/Sub-triggered pipeline stage."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

from . import probes, verify
from .agents import (
    evaluate_findings_agent,
    normalize_rubric_agent,
    plan_actions_agent,
    run_structured,
)
from .devpost import fetch_source
from .github_client import (
    GitHubError,
    action_idempotency_key,
    create_issue_idempotent,
    upsert_file_idempotent,
)
from .web_client import WebApiError, get_job, post as web_post

logger = logging.getLogger("closefold.stages")

Handler = Callable[[str], Awaitable[None]]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def run_ingest(job_id: str) -> None:
    job = get_job(job_id)
    src = fetch_source(job["config"]["devpostUrl"])
    web_post(
        "/api/internal/ingest",
        {
            "jobId": job_id,
            "stage": "ingest",
            "sourceUrl": src.url,
            "httpStatus": src.http_status,
            "bytes": src.bytes_downloaded,
            "digest": src.digest,
            "extractedSections": src.sections,
        },
    )


async def run_normalize(job_id: str) -> None:
    job = get_job(job_id)
    src = fetch_source(job["config"]["devpostUrl"])
    prompt = (
        "Convert this live hackathon page content into the compliance rubric.\n"
        f"Source URL: {src.url}\nPage title: {src.title}\n\n"
        f"Extracted sections:\n{src.text[:60000]}"
    )
    result = await run_structured(normalize_rubric_agent(), prompt)
    for item in result["items"]:
        item.setdefault("weight", 1.0)
        item["evidenceHint"] = item.pop("evidence_hint", None)
    web_post(
        "/api/internal/rubric",
        {"jobId": job_id, "stage": "normalize", "sourceUrl": src.url, "items": result["items"]},
    )


async def run_collect(job_id: str) -> None:
    job = get_job(job_id)
    observations = probes.run_all_observations(job["config"])
    web_post(
        "/api/internal/observations",
        {"jobId": job_id, "stage": "collect", "observations": observations},
    )


def _compact_observations(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact = []
    for o in observations:
        compact.append(
            {
                "kind": o.get("kind"),
                "target": o.get("target"),
                "url": o.get("url"),
                "ok": o.get("ok"),
                "digest": o.get("digest"),
                "detail": o.get("detail", {}),
                "excerpt": (o.get("excerpt") or "")[:1200],
            }
        )
    return compact


def _fresh_observations_for_prompt(job: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        return probes.run_all_observations(job["config"])
    except Exception as exc:  # noqa: BLE001 - evaluation proceeds on empty evidence
        logger.warning("probe refresh during evaluate failed: %s", exc)
        return []


async def run_evaluate(job_id: str) -> None:
    job = get_job(job_id)
    observations = _compact_observations(_fresh_observations_for_prompt(job))
    rubric_lines = [
        f"- id={i['id']} category={i['category']} requirement={i['requirement']}"
        for i in job.get("rubric", [])
    ]
    prompt = (
        "Rubric items:\n" + "\n".join(rubric_lines) + "\n\n"
        "Raw observations (fetched from live sources):\n"
        + json.dumps(observations)[:100000]
    )
    result = await run_structured(evaluate_findings_agent(), prompt)
    findings = []
    for f in result["findings"]:
        findings.append(
            {
                "rubricItemId": f["rubric_item_id"],
                "status": f["status"],
                "rationale": f["rationale"],
                "evidence": [
                    {
                        "kind": e["kind"],
                        "url": e["url"],
                        "fetchedAt": _now(),
                        **({"digest": e["digest"]} if e.get("digest") else {}),
                    }
                    for e in f.get("evidence", [])
                ],
            }
        )
    web_post("/api/internal/findings", {"jobId": job_id, "stage": "evaluate", "findings": findings})


async def run_plan(job_id: str) -> None:
    job = get_job(job_id)
    gaps = [f for f in job.get("findings", []) if f["status"] != "satisfied"]
    rubric_by_id = {i["id"]: i for i in job.get("rubric", [])}
    gap_lines = []
    for f in gaps:
        item = rubric_by_id.get(f["rubricItemId"], {})
        gap_lines.append(
            f"- finding={f['rubricItemId']} status={f['status']} "
            f"category={item.get('category', '?')} requirement={item.get('requirement', f['rubricItemId'])} "
            f"rationale={f['rationale']}"
        )
    repo = f"{job['config']['githubOwner']}/{job['config']['githubRepo']}"
    prompt = (
        f"Repository: {repo}\n"
        "Consult prior audit context below when choosing file paths.\n\n"
        "Unresolved evidence gaps:\n" + ("\n".join(gap_lines) if gap_lines else "(none)") + "\n\n"
        "Propose corrective actions per your instructions."
    )
    result = await run_structured(plan_actions_agent(), prompt)
    actions_out = []
    for a in result["actions"][:5]:
        payload = dict(a["payload"])
        payload.setdefault("type", a["type"])
        actions_out.append(
            {
                "id": a["id"],
                "type": a["type"],
                "title": a["title"],
                "description": a["description"],
                "rubricItemIds": a.get("rubric_item_ids", []),
                "payload": payload,
            }
        )
    response = web_post("/api/internal/plan", {"jobId": job_id, "stage": "plan", "actions": actions_out})
    logger.info("plan accepted: %s", json.dumps(response))


async def run_act(job_id: str) -> None:
    job = get_job(job_id)
    owner = job["config"]["githubOwner"]
    repo = job["config"]["githubRepo"]
    executable = [
        a
        for a in job.get("actions", [])
        if a.get("state") == "planned"
        and (not a.get("requiresApproval") or a.get("approvalState") == "approved")
    ]
    if not executable:
        web_post(f"/api/internal/act/{job_id}/complete", {"stage": "act"})
        return

    for action in executable:
        payload = action.get("payload", {})
        key = action_idempotency_key(job_id, action["id"], payload)
        detail: dict[str, Any] = {"ownerRepo": f"{owner}/{repo}", "idempotencyKey": key}
        outcome = "failed"
        artifact = None
        try:
            if action["type"] == "github_upsert_file":
                result = upsert_file_idempotent(
                    owner,
                    repo,
                    path=payload["path"],
                    branch=payload.get("branch", "main"),
                    content=payload["content"],
                    message=payload["commitMessage"],
                    idempotency_key=key,
                )
                outcome = result["outcome"]
                artifact = {"kind": "github_blob", "url": result["artifact_url"], "fetchedAt": _now()}
                detail.update({k: v for k, v in result.items() if k != "outcome"})
            elif action["type"] == "github_create_issue":
                result = create_issue_idempotent(
                    owner,
                    repo,
                    title=payload["title"],
                    body=payload["body"],
                    labels=payload.get("labels", []),
                    idempotency_key=key,
                )
                outcome = result["outcome"]
                artifact = {"kind": "github_api", "url": result["artifact_url"], "fetchedAt": _now()}
                detail.update({k: v for k, v in result.items() if k != "outcome"})
        except GitHubError as exc:
            outcome = "failed"
            detail["error"] = str(exc)
        web_post(
            "/api/internal/receipt",
            {
                "jobId": job_id,
                "actionId": action["id"],
                "actionType": action["type"],
                "idempotencyKey": key,
                "outcome": outcome,
                "artifact": artifact,
                "detail": detail,
            },
        )

    # Receipt endpoint advances to verify once all actions reported; belt-and-braces:
    refreshed = get_job(job_id)
    if refreshed["stage"] == "act":
        web_post(f"/api/internal/act/{job_id}/complete", {"stage": "act"})


async def run_verify(job_id: str) -> None:
    job = get_job(job_id)
    fresh = probes.run_all_observations(job["config"])

    results: list[dict[str, Any]] = []
    for item in job.get("rubric", []):
        r = verify.verify_rubric_item(item, fresh)
        r["evidence"]["fetchedAt"] = _now()
        results.append(r)

    executed = [a for a in job.get("actions", []) if a.get("state") == "executed"]
    receipt_by_action = {r["actionId"]: r for r in _receipts_for_job(job_id)}
    for action in executed:
        receipt = receipt_by_action.get(action["id"], {})
        av = verify.verify_action(job_id, action, receipt.get("detail", {}))
        av["evidence"]["fetchedAt"] = _now()
        rid = av.get("rubricItemId")
        if av["verified"] and rid:
            for idx, r in enumerate(results):
                if r["rubricItemId"] == rid:
                    results[idx] = av
        elif rid:
            results.append(av)

    web_post("/api/internal/verification", {"jobId": job_id, "results": results})


def _receipts_for_job(job_id: str) -> list[dict[str, Any]]:
    """Fetches receipts through the internal receipts mirror endpoint."""
    from .web_client import _client  # intentional reuse of authed client

    with _client() as c:
        res = c.get(f"/api/internal/job/{job_id}/receipts")
    if res.status_code != 200:
        return []
    return res.json().get("receipts", [])


HANDLERS: dict[str, Handler] = {
    "ingest": run_ingest,
    "normalize": run_normalize,
    "collect": run_collect,
    "evaluate": run_evaluate,
    "plan": run_plan,
    "act": run_act,
    "verify": run_verify,
}


def classify_failure(exc: Exception) -> bool:
    """Returns True when the failure is permanent and must not be retried."""
    if isinstance(exc, WebApiError):
        return exc.permanent
    if isinstance(exc, GitHubError):
        return exc.permanent
    if isinstance(exc, httpx.HTTPStatusError):
        return False
    if isinstance(exc, httpx.HTTPError):
        return False
    if isinstance(exc, KeyError):
        return True
    return False


async def dispatch(job_id: str, stage: str) -> bool:
    """Executes a stage. Returns True when any failure was permanent (already reported)."""
    handler = HANDLERS.get(stage)
    if handler is None:
        web_post(
            "/api/internal/failure",
            {"jobId": job_id, "stage": stage, "error": f"no handler for stage '{stage}'", "permanent": True},
        )
        return True
    try:
        await handler(job_id)
        return True
    except Exception as exc:  # noqa: BLE001 - classified and reported, never swallowed silently
        permanent = classify_failure(exc)
        logger.exception("stage %s failed for job %s (permanent=%s)", stage, job_id, permanent)
        try:
            web_post(
                "/api/internal/failure",
                {"jobId": job_id, "stage": stage, "error": f"{type(exc).__name__}: {exc}", "permanent": permanent},
            )
        except Exception:  # noqa: BLE001
            logger.exception("failure reporting also failed")
        return permanent
