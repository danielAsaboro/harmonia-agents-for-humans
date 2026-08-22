"""X (Twitter) API v2 publish + verify client."""

from __future__ import annotations

import os

import httpx


class XError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def permanent(self) -> bool:
        return self.status is not None and 400 <= self.status < 500 and self.status != 429


def _bearer() -> str:
    token = os.environ.get("X_BEARER_TOKEN")
    if not token:
        raise XError("X_BEARER_TOKEN is not configured", 401)
    return token


def publish_post(text: str) -> dict:
    with httpx.Client(timeout=30) as c:
        res = c.post(
            "https://api.x.com/2/tweets",
            headers={"Authorization": f"Bearer {_bearer()}"},
            json={"text": text},
        )
    if res.status_code not in (200, 201):
        raise XError(f"tweet create failed: {res.status_code} {res.text[:200]}", res.status_code)
    data = res.json()["data"]
    return {"id": data["id"], "url": f"https://x.com/i/web/status/{data['id']}"}


def get_post(post_id: str) -> dict | None:
    with httpx.Client(timeout=20) as c:
        res = c.get(
            f"https://api.x.com/2/tweets/{post_id}",
            headers={"Authorization": f"Bearer {_bearer()}"},
        )
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise XError(f"tweet fetch failed: {res.status_code}", res.status_code)
    return res.json()["data"]
