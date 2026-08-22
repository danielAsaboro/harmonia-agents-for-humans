"""Typed client for the Harmonia web internal API (all persistence flows
through the web service so the state machine has a single writer)."""

from __future__ import annotations

from typing import Any

import httpx

from .config import settings


class WebApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def permanent(self) -> bool:
        # 4xx (except 429) means our payload/flow is wrong; retrying will not help.
        return self.status is not None and 400 <= self.status < 500 and self.status != 429


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=settings().web_internal_url,
        headers={"Authorization": f"Bearer {settings().internal_api_token}"},
        timeout=30,
    )


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


def get_insights() -> dict[str, Any]:
    """Cross-job reaction insights for the feedback loop (may be empty early)."""
    with _client() as c:
        res = c.get("/api/internal/insights")
    if res.status_code != 200:
        raise WebApiError(f"get_insights failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _client() as c:
        res = c.post(path, json=payload)
    if res.status_code >= 300:
        raise WebApiError(f"{path} failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def _operator_client() -> httpx.Client:
    """Client carrying operator authority for the Telegram surface only.
    The token is sent to the web service, never echoed back to chats."""
    headers: dict[str, str] = {}
    operator_token = settings().operator_token
    if operator_token:
        headers["x-operator-token"] = operator_token
    return httpx.Client(
        base_url=settings().web_internal_url,
        headers={"Authorization": f"Bearer {settings().internal_api_token}", **headers},
        timeout=60,
    )


def chat(message: str, surface: str = "telegram") -> dict[str, Any]:
    with _operator_client() as c:
        res = c.post("/api/chat", json={"message": message, "surface": surface})
    if res.status_code >= 300:
        raise WebApiError(f"chat failed: {res.status_code} {res.text}", res.status_code)
    return res.json()


def decide(job_id: str, action_id: str, decision: str) -> dict[str, Any]:
    with _operator_client() as c:
        res = c.post(
            f"/api/jobs/{job_id}/actions/{action_id}/decision",
            json={"decision": decision, "actor": "operator"},
        )
    if res.status_code >= 300:
        raise WebApiError(
            f"decision failed: {res.status_code} {res.text}", res.status_code
        )
    return res.json()
