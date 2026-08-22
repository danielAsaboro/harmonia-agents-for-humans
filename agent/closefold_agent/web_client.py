"""Typed client for the Closefold web internal API (all persistence flows
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


def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _client() as c:
        res = c.post(path, json=payload)
    if res.status_code >= 300:
        raise WebApiError(f"{path} failed: {res.status_code} {res.text}", res.status_code)
    return res.json()
