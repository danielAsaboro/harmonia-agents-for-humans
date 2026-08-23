"""X (Twitter) API v2 publish + verify client.

Offline dev mode: when HARMONIA_MOCK_X=1 is explicitly set (independent of
HARMONIA_MOCK_AI), publish/verify/metrics return small deterministic payloads
and never touch the network. With the flag unset every call is real.
"""

from __future__ import annotations

import hashlib
import os

import httpx


class XError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def permanent(self) -> bool:
        return self.status is not None and 400 <= self.status < 500 and self.status != 429


def _mock_x() -> bool:
    return os.environ.get("HARMONIA_MOCK_X") == "1"


def _log(message: str) -> None:
    print(f"[MOCK-X] {message}", flush=True)


def _mock_id(text: str) -> str:
    return f"mock-{hashlib.sha256(text.encode()).hexdigest()[:12]}"


def _bearer(token: str | None) -> str:
    if not token:
        raise XError("workspace X connection is not configured", 401)
    return token


def publish_post(text: str, bearer_token: str | None = None) -> dict:
    if _mock_x():
        pid = _mock_id(text)
        _log(f"publish_post: returning deterministic id {pid}")
        return {"id": pid, "url": f"https://x.com/i/web/status/{pid}"}
    with httpx.Client(timeout=30) as c:
        res = c.post(
            "https://api.x.com/2/tweets",
            headers={"Authorization": f"Bearer {_bearer(bearer_token)}"},
            json={"text": text},
        )
    if res.status_code not in (200, 201):
        raise XError(f"tweet create failed: {res.status_code} {res.text[:200]}", res.status_code)
    data = res.json()["data"]
    return {"id": data["id"], "url": f"https://x.com/i/web/status/{data['id']}"}


def get_post(post_id: str, bearer_token: str | None = None) -> dict | None:
    if _mock_x():
        _log(f"get_post({post_id}): returning deterministic payload")
        return {"id": post_id, "text": "(mock offline post)"}
    with httpx.Client(timeout=20) as c:
        res = c.get(
            f"https://api.x.com/2/tweets/{post_id}",
            headers={"Authorization": f"Bearer {_bearer(bearer_token)}"},
        )
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise XError(f"tweet fetch failed: {res.status_code}", res.status_code)
    return res.json()["data"]


def get_post_metrics(post_id: str, bearer_token: str | None = None) -> dict | None:
    """Fetches reaction metrics for a published post (learn stage)."""
    if _mock_x():
        h = int(hashlib.sha256(str(post_id).encode()).hexdigest(), 16)
        metrics = {
            "likes": 5 + h % 40,
            "replies": h % 7,
            "reposts": h % 11,
            "quotes": h % 3,
            "impressions": 200 + h % 1800,
        }
        _log(f"get_post_metrics({post_id}): returning deterministic payload {metrics}")
        return metrics
    with httpx.Client(timeout=20) as c:
        res = c.get(
            f"https://api.x.com/2/tweets/{post_id}",
            headers={"Authorization": f"Bearer {_bearer(bearer_token)}"},
            params={"tweet.fields": "public_metrics"},
        )
    if res.status_code == 404:
        return None
    if res.status_code != 200:
        raise XError(f"metrics fetch failed: {res.status_code}", res.status_code)
    data = res.json()["data"]
    m = data.get("public_metrics", {})
    return {
        "likes": int(m.get("like_count", 0)),
        "replies": int(m.get("reply_count", 0)),
        "reposts": int(m.get("retweet_count", 0)),
        "quotes": int(m.get("quote_count", 0)),
        "impressions": int(m["impression_count"]) if "impression_count" in m else None,
    }
