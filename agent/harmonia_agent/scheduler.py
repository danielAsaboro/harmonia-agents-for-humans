"""Scheduler dispatcher: publishes content items when they come due.

Runs as a background thread inside the FastAPI worker. Every 60s it asks the
web service for due/publishing items; auto-mode items publish immediately
(scheduling was the approval), and publishing items are retries of approved
final-review items. Outcomes report back through the internal API, which
records receipts-style state and fires notifications.

Only official platform APIs are used (X today via x_client). A platform that
is not connected fails visibly — never silently skipped.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time

import httpx

from . import x_client
from .config import settings
from .web_client import WebApiError

logger = logging.getLogger("harmonia.scheduler")

POLL_SECONDS = 60


def _publish_to_platform(platform: str, text: str) -> dict:
    if platform == "x":
        return x_client.publish_post(text)
    raise RuntimeError(f"platform '{platform}' has no publish adapter yet")


async def _tick() -> None:
    cfg = settings()
    async with httpx.AsyncClient(
        base_url=cfg.web_internal_url,
        headers={"Authorization": f"Bearer {cfg.internal_api_token}"},
        timeout=30,
    ) as client:
        res = await client.get("/api/internal/items")
        if res.status_code != 200:
            logger.warning("scheduler feed failed: %s", res.status_code)
            return
        feed = res.json()
        jobs = [
            *({"id": i["id"], "text": i["text"], "platforms": i["platforms"]} for i in feed.get("due", [])),
            *({"id": i["id"], "text": i["text"], "platforms": i["platforms"]} for i in feed.get("publishing", [])),
        ]

    for job in jobs:
        outcome_status, post_id, post_url, failure = "published", None, None, None
        try:
            for platform in job["platforms"]:
                posted = _publish_to_platform(platform, job["text"])
                post_id, post_url = posted["id"], posted["url"]
                break  # single-platform posting for now; fan-out lands per platform adapter
        except Exception as exc:  # noqa: BLE001 - failures must be visible, not crash the loop
            outcome_status = "failed"
            failure = f"{type(exc).__name__}: {exc}"
            logger.error("item %s publish failed: %s", job["id"], failure)

        try:
            async with httpx.AsyncClient(
                base_url=cfg.web_internal_url,
                headers={"Authorization": f"Bearer {cfg.internal_api_token}"},
                timeout=30,
            ) as client:
                await client.post(
                    "/api/internal/items",
                    json={
                        "id": job["id"],
                        "status": outcome_status,
                        **({"publishedPostId": post_id, "publishedUrl": post_url} if post_id else {}),
                        **({"failureReason": failure} if failure else {}),
                    },
                )
        except WebApiError as exc:
            logger.error("item %s result reporting failed: %s", job["id"], exc)


def _run_loop() -> None:
    logger.info("scheduler dispatcher started (every %ss)", POLL_SECONDS)
    while True:
        try:
            asyncio.run(_tick())
        except Exception:  # noqa: BLE001 - keep the loop alive
            logger.exception("scheduler tick failed")
        time.sleep(POLL_SECONDS)


def start_background() -> None:
    threading.Thread(target=_run_loop, daemon=True).start()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    _run_loop()
