"""Typed client for the Harmonia web internal API (all persistence flows
through the web service so the state machine has a single writer)."""

from __future__ import annotations

from typing import Any

import httpx

from .config import settings
from .telemetry import inject_context
from .tenant_context import current_tenant


class WebApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def permanent(self) -> bool:
        # 4xx (except 429) means our payload/flow is wrong; retrying will not help.
        return self.status is not None and 400 <= self.status < 500 and self.status != 429


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


def get_asset(job_id: str, action_id: str) -> dict[str, Any] | None:
    """Independent re-read of a stored asset for verification."""
    with _client() as c:
        res = c.get(f"/api/internal/job/{job_id}/assets/{action_id}")
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise WebApiError(f"get_asset failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


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


def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _client() as c:
        res = c.post(path, json=payload)
    if res.status_code >= 300:
        raise WebApiError(f"{path} failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def reserve_budget(payload: dict[str, object]) -> None:
    with _client() as c:
        res = c.post("/api/internal/budget/reserve", json=payload)
    if res.status_code >= 300:
        raise WebApiError(
            f"budget reservation failed: {res.status_code} {res.text}", res.status_code
        )


def report_usage(payload: dict[str, object]) -> None:
    with _client() as c:
        res = c.post("/api/internal/usage", json=payload)
    if res.status_code >= 300:
        raise WebApiError(f"usage reporting failed: {res.status_code} {res.text}", res.status_code)


def chat(message: str, surface: str = "telegram") -> dict[str, Any]:
    with _client() as c:
        res = c.post("/api/chat", json={"message": message, "surface": surface})
    if res.status_code >= 300:
        raise WebApiError(f"chat failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def decide(job_id: str, action_id: str, decision: str) -> dict[str, Any]:
    with _client() as c:
        res = c.post(
            f"/api/jobs/{job_id}/actions/{action_id}/decision",
            json={"decision": decision, "actor": "operator"},
        )
    if res.status_code >= 300:
        raise WebApiError(
            f"decision failed: {res.status_code} {res.text}", res.status_code
        )
    return res.json()
