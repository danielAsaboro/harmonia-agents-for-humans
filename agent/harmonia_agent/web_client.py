"""Typed client for the Harmonia web internal API (all persistence flows
through the web service so the state machine has a single writer)."""

from __future__ import annotations

from typing import Any
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import secrets
from urllib.parse import unquote

import httpx

from .config import settings
from .telemetry import inject_context
from .tenant_context import current_tenant
from .activity_models import AgentActivityRecord
from .operation_context import operation_headers


class WebApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def permanent(self) -> bool:
        # 4xx (except 429) means our payload/flow is wrong; retrying will not help.
        return self.status is not None and 400 <= self.status < 500 and self.status != 429


class EffectClaimInProgress(RuntimeError):
    pass


class EffectClaimUncertain(RuntimeError):
    pass


def _client(*, tenant_required: bool = True) -> httpx.Client:
    tenant = current_tenant() if tenant_required else None
    headers = {
        "Authorization": f"Bearer {settings().internal_api_token}",
    }
    if tenant is not None:
        headers.update({
            "x-workspace-id": tenant.workspace_id,
            "x-brand-id": tenant.brand_id,
        })
    headers.update(operation_headers())
    inject_context(headers)
    return httpx.Client(
        base_url=settings().web_internal_url,
        headers=headers,
        timeout=30,
    )


def get_workspaces() -> list[dict[str, str]]:
    with _client(tenant_required=False) as c:
        res = c.get("/api/internal/workspaces")
    if res.status_code != 200:
        raise WebApiError(f"workspace feed failed: {res.status_code} {res.text}", res.status_code)
    return list(res.json().get("workspaces") or [])


def get_connection(platform: str) -> dict[str, Any]:
    with _client() as c:
        res = c.get(f"/api/internal/connection/{platform}")
    if res.status_code != 200:
        raise WebApiError(f"{platform} connection unavailable: {res.status_code}", res.status_code)
    return dict(res.json()["connection"])


def get_telegram_connection() -> dict[str, Any] | None:
    with _client() as c:
        res = c.get("/api/internal/telegram")
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise WebApiError(f"Telegram connection unavailable: {res.status_code}", res.status_code)
    return dict(res.json()["connection"])


def get_job(job_id: str) -> dict[str, Any]:
    with _client() as c:
        res = c.get(f"/api/internal/job/{job_id}")
    if res.status_code != 200:
        raise WebApiError(f"get_job failed: {res.status_code} {res.text}", res.status_code)
    return res.json()["job"]


def get_editorial_planning_snapshot(job_id: str) -> dict[str, Any]:
    """Create or re-read the immutable Firestore planning snapshot for Temi."""
    with _client() as c:
        res = c.get("/api/internal/editorial-planning-snapshot", params={"jobId": job_id})
    if res.status_code != 200:
        raise WebApiError(
            f"editorial planning snapshot unavailable: {res.status_code} {res.text}",
            res.status_code,
        )
    return dict(res.json())


def search_verified_publications(query: str, limit: int = 5) -> dict[str, Any]:
    with _client() as c:
        res = c.get("/api/internal/published-content", params={"q": query, "limit": limit})
    if res.status_code != 200:
        raise WebApiError(f"verified publication search failed: {res.status_code}", res.status_code)
    return dict(res.json())


def get_effect_commands(job_id: str) -> list[dict[str, Any]]:
    with _client() as c:
        res = c.get(f"/api/internal/job/{job_id}/commands")
    if res.status_code != 200:
        raise WebApiError(f"effect command feed failed: {res.status_code} {res.text}", res.status_code)
    return list(res.json().get("commands") or [])


def get_effect_command(command_id: str) -> dict[str, Any]:
    with _client() as c:
        res = c.get(f"/api/internal/effect-command/{command_id}")
    if res.status_code != 200:
        raise WebApiError(f"effect command unavailable: {res.status_code} {res.text}", res.status_code)
    return dict(res.json()["command"])


def get_due_effect_command_ids() -> list[str]:
    with _client() as c:
        res = c.get("/api/internal/items")
    if res.status_code != 200:
        raise WebApiError(f"scheduler command feed failed: {res.status_code} {res.text}", res.status_code)
    return [str(value) for value in res.json().get("commandIds") or []]


def get_asset(job_id: str, action_id: str) -> dict[str, Any] | None:
    """Independent re-read of a stored asset for verification."""
    with _client() as c:
        res = c.get(f"/api/internal/job/{job_id}/assets/{action_id}")
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise WebApiError(f"get_asset failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def get_chat_attachment(attachment_id: str) -> tuple[bytes, str, str]:
    """Fetch one ready tenant-scoped operator upload for media processing."""
    with _client() as c:
        res = c.get(f"/api/internal/chat-attachments/{attachment_id}")
    if res.status_code != 200:
        raise WebApiError(
            f"chat attachment unavailable: {res.status_code} {res.text}", res.status_code
        )
    mime = res.headers.get("content-type") or "application/octet-stream"
    filename = unquote(res.headers.get("x-attachment-filename") or attachment_id)
    return res.content, mime, filename


def get_media_operation(job_id: str, action_id: str) -> dict[str, Any] | None:
    with _client() as c:
        res = c.get(f"/api/internal/job/{job_id}/actions/{action_id}/operation")
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise WebApiError(
            f"get_media_operation failed: {res.status_code} {res.text}", res.status_code
        )
    return res.json()["operation"]


def save_media_operation(
    job_id: str, action_id: str, provider: str, operation_name: str,
) -> None:
    with _client() as c:
        res = c.post(
            f"/api/internal/job/{job_id}/actions/{action_id}/operation",
            json={"provider": provider, "operationName": operation_name},
        )
    if res.status_code >= 300:
        raise WebApiError(
            f"save_media_operation failed: {res.status_code} {res.text}", res.status_code
        )


def get_insights() -> dict[str, Any]:
    """Cross-job reaction insights for the feedback loop (may be empty early)."""
    with _client() as c:
        res = c.get("/api/internal/insights")
    if res.status_code != 200:
        raise WebApiError(f"get_insights failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def get_feed() -> dict[str, Any]:
    """One-stop proactive-agent feed: items, job health, goals, recent posts."""
    with _client() as c:
        res = c.get("/api/internal/proactive-feed")
    if res.status_code != 200:
        raise WebApiError(f"get_feed failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def get_state(key: str) -> dict[str, Any] | None:
    """Persisted cadence marker for a proactive check (may be absent)."""
    with _client() as c:
        res = c.get("/api/internal/agent-state", params={"key": key})
    if res.status_code != 200:
        raise WebApiError(f"get_state failed: {res.status_code} {res.text}", res.status_code)
    return res.json().get("state")


def put_state(key: str, last_run_at: str) -> None:
    with _client() as c:
        res = c.put("/api/internal/agent-state", json={"key": key, "lastRunAt": last_run_at})
    if res.status_code >= 300:
        raise WebApiError(f"put_state failed: {res.status_code} {res.text}", res.status_code)


def claim_tick(key: str, claim_id: str, lease_seconds: int = 55) -> bool:
    with _client() as c:
        res = c.post("/api/internal/agent-state", json={
            "key": key, "claimId": claim_id, "leaseSeconds": lease_seconds,
        })
    if res.status_code != 200:
        raise WebApiError(f"tick claim failed: {res.status_code} {res.text}", res.status_code)
    return bool(res.json().get("claimed"))


def run_retention_tick(limit: int = 20) -> list[str]:
    with _client() as c:
        res = c.post("/api/internal/retention", json={"limit": limit})
    if res.status_code != 200:
        raise WebApiError(f"retention tick failed: {res.status_code} {res.text}", res.status_code)
    return [str(value) for value in res.json().get("erasedJobIds") or []]


def run_stage_outbox_tick(limit: int = 20) -> list[dict[str, Any]]:
    with _client() as c:
        res = c.post("/api/internal/stage-outbox", json={"limit": limit})
    if res.status_code != 200:
        raise WebApiError(f"stage outbox tick failed: {res.status_code} {res.text}", res.status_code)
    return list(res.json().get("results") or [])


def claim_autonomy_cycle(cycle_type: str, scheduled_at: str, lease_seconds: int) -> dict[str, Any]:
    """Create-once and claim a tenant-scoped resident cycle."""
    tenant = current_tenant()
    normalized = datetime.fromisoformat(scheduled_at.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    cycle_id = hashlib.sha256(f"{tenant.workspace_id}\n{tenant.brand_id}\n{cycle_type}\n{normalized}".encode()).hexdigest()
    cycle = {"id": cycle_id, "workspaceId": tenant.workspace_id, "brandId": tenant.brand_id, "type": cycle_type, "state": "scheduled", "scheduledAt": normalized, "timezone": "Etc/UTC", "triggerReason": "authenticated_scheduler_wake", "cycleVersion": "1", "effectBearing": False, "armsAttempted": [], "evidenceRefs": [], "modelUsageIds": [], "estimatedCostUsd": 0, "outcome": "scheduled"}
    token = secrets.token_hex(24)
    now = datetime.now(timezone.utc)
    with _client() as c:
        created = c.post("/api/internal/autonomy/cycles", json=cycle)
        if created.status_code >= 300: raise WebApiError(f"cycle create failed: {created.status_code} {created.text}", created.status_code)
        claim = c.post(f"/api/internal/autonomy/cycles/{cycle_id}/claim", json={"ownerId": "harmonia-agent", "claimToken": token, "now": now.isoformat(), "leaseExpiresAt": (now + timedelta(seconds=lease_seconds)).isoformat()})
        if claim.status_code >= 300: raise WebApiError(f"cycle claim failed: {claim.status_code} {claim.text}", claim.status_code)
        body = claim.json()
        if body.get("outcome") == "execute":
            running = c.post(f"/api/internal/autonomy/cycles/{cycle_id}/transition", json={"state": "running", "at": now.isoformat(), "claimToken": token, "outcome": "resident cycle running"})
            if running.status_code >= 300: raise WebApiError(f"cycle start failed: {running.status_code} {running.text}", running.status_code)
            body.update({"cycleId": cycle_id, "claimToken": token})
        return body


def finalize_autonomy_cycle(result: dict[str, Any]) -> None:
    cycle_id, token = str(result["cycleId"]), str(result["claimToken"])
    state = str(result.get("status", "failed"))
    if state not in {"completed", "partially_completed", "failed", "uncertain"}: state = "failed"
    with _client() as c:
        res = c.post(f"/api/internal/autonomy/cycles/{cycle_id}/transition", json={"state": state, "at": datetime.now(timezone.utc).isoformat(), "claimToken": token, "outcome": str(result.get("outcome", state))[:200]})
    if res.status_code >= 300: raise WebApiError(f"cycle finalize failed: {res.status_code} {res.text}", res.status_code)


def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _client() as c:
        res = c.post(path, json=payload)
    if res.status_code >= 300:
        raise WebApiError(f"{path} failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def claim_effect(payload: dict[str, Any]) -> dict[str, Any]:
    result = post("/api/internal/effect-claim", payload)
    outcome = result.get("outcome")
    if outcome not in {"execute", "in_progress", "already_applied", "uncertain"}:
        raise WebApiError("effect claim returned an invalid outcome")
    return result


def claim_stage_execution(payload: dict[str, Any]) -> dict[str, Any]:
    result = post("/api/internal/stage-execution/claim", payload)
    if result.get("outcome") not in {
        "execute", "in_progress", "already_applied", "failed", "uncertain",
    }:
        raise WebApiError("stage execution claim returned an invalid outcome")
    return result


def claim_event_inbox(payload: dict[str, Any]) -> dict[str, Any]:
    result = post("/api/internal/event-inbox/claim", payload)
    if result.get("outcome") not in {
        "execute", "in_progress", "already_completed", "rejected",
    }:
        raise WebApiError("event inbox claim returned an invalid outcome")
    return result


def claim_operation(payload: dict[str, Any]) -> dict[str, Any]:
    result = post("/api/internal/operation/claim", payload)
    if result.get("outcome") not in {
        "execute", "in_progress", "unknown", "succeeded", "failed", "cancelled",
    }:
        raise WebApiError("operation claim returned an invalid outcome")
    return result


def complete_event_inbox(payload: dict[str, Any]) -> None:
    post("/api/internal/event-inbox/finalize", payload)


def create_artifact(
    *,
    job_id: str,
    operation_id: str,
    content: bytes,
    content_type: str,
    trust: str,
    producer: dict[str, str],
    retention_class: str,
    source_event_id: str | None = None,
    expires_at: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "jobId": job_id,
        "operationId": operation_id,
        "dataBase64": base64.b64encode(content).decode("ascii"),
        "contentType": content_type,
        "trust": trust,
        "producer": producer,
        "retentionClass": retention_class,
    }
    if source_event_id:
        payload["sourceEventId"] = source_event_id
    if expires_at:
        payload["expiresAt"] = expires_at
    with _client() as c:
        res = c.post("/api/internal/artifacts", json=payload)
    if res.status_code != 201:
        raise WebApiError(
            f"artifact creation failed: {res.status_code} {res.text}", res.status_code
        )
    return dict(res.json()["artifact"])


def read_artifact(
    artifact_id: str,
    *,
    offset: int | None = None,
    length: int | None = None,
    line_start: int | None = None,
    line_count: int | None = None,
) -> dict[str, Any]:
    byte_mode = offset is not None or length is not None
    line_mode = line_start is not None or line_count is not None
    if byte_mode == line_mode:
        raise ValueError("provide exactly one artifact byte or line window")
    if byte_mode:
        if offset is None or length is None:
            raise ValueError("artifact byte window is incomplete")
        params = {"offset": offset, "length": length}
    else:
        if line_start is None or line_count is None:
            raise ValueError("artifact line window is incomplete")
        params = {"lineStart": line_start, "lineCount": line_count}
    with _client() as c:
        res = c.get(f"/api/internal/artifacts/{artifact_id}", params=params)
    if res.status_code != 200:
        raise WebApiError(
            f"artifact read failed: {res.status_code} {res.text}", res.status_code
        )
    return dict(res.json())


def finalize_stage_execution(payload: dict[str, Any]) -> None:
    post("/api/internal/stage-execution/finalize", payload)


def reserve_budget(payload: dict[str, object]) -> None:
    with _client() as c:
        res = c.post("/api/internal/budget/reserve", json=payload)
    if res.status_code >= 300:
        raise WebApiError(
            f"budget reservation failed: {res.status_code} {res.text}", res.status_code
        )


def resolve_budget_reservation(payload: dict[str, object]) -> None:
    with _client() as c:
        res = c.post("/api/internal/budget/resolve", json=payload)
    if res.status_code >= 300:
        raise WebApiError(
            f"budget reservation resolution failed: {res.status_code} {res.text}",
            res.status_code,
        )


def report_usage(payload: dict[str, object]) -> None:
    with _client() as c:
        res = c.post("/api/internal/usage", json=payload)
    if res.status_code >= 300:
        raise WebApiError(f"usage reporting failed: {res.status_code} {res.text}", res.status_code)


def record_agent_activity(record: AgentActivityRecord) -> None:
    """Persist one strict metadata-only activity projection, retrying transient failure once."""
    for attempt in range(2):
        with _client() as c:
            res = c.post("/api/internal/observability", json=record.to_wire())
        if res.status_code < 300:
            return
        retryable = res.status_code == 429 or res.status_code >= 500
        if not retryable or attempt == 1:
            raise WebApiError(
                f"agent activity reporting failed: {res.status_code}", res.status_code,
            )


def chat(message: str, surface: str = "telegram") -> dict[str, Any]:
    with _client() as c:
        res = c.post("/api/chat", json={"message": message, "surface": surface})
    if res.status_code >= 300:
        raise WebApiError(f"chat failed: {res.status_code} {res.text}", res.status_code)
    return res.json()
