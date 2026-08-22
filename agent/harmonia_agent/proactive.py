"""Proactive agent: watches events and proposes content without being asked.

Background thread inside the FastAPI worker (alongside the scheduler). Each
tick it: gathers external signals from official keyless sources (Hacker News
front page via Algolia), turns them into topic proposals with reasons and
source URLs, and watches published-post engagement for outliers worth doubling
down on. Proposals are deduplicated by deterministic id and only become jobs
when the operator approves them - the approval gate is never bypassed.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import threading
import time
from typing import Any

import httpx

from . import content
from .mock_ai import mock_ai_enabled
from .web_client import WebApiError, get_insights, post as web_post

logger = logging.getLogger("harmonia.proactive")

HN_FRONT_PAGE = "https://hn.algolia.com/api/v1/search"
POLL_SECONDS = int(os.environ.get("PROACTIVE_INTERVAL_SECONDS", "900"))
MAX_PROPOSALS_PER_TICK = 3
OUTLIER_FACTOR = 2.0


def _proposal_id(source: str, topic: str) -> str:
    return f"prop-{hashlib.sha256(f'{source}:{topic}'.encode()).hexdigest()[:16]}"


def build_proposals(ideas: list[dict[str, Any]], source: str) -> list[dict[str, Any]]:
    """Normalizes idea dicts into proposal payloads with deterministic ids."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for idea in ideas[:MAX_PROPOSALS_PER_TICK]:
        topic = str(idea.get("topic", "")).strip()
        if not topic:
            continue
        pid = _proposal_id(source, topic)
        if pid in seen:
            continue
        seen.add(pid)
        out.append({
            "id": pid,
            "source": source,
            "topic": topic[:300],
            "angle": str(idea.get("angle", "")).strip()[:300],
            "reason": str(idea.get("reason", "")).strip()[:600],
            "sources": [str(u) for u in (idea.get("sources") or [])][:5],
            "suggestedPost": str(idea.get("suggestedPost", "")).strip()[:280],
        })
    return out


def fetch_signals(limit: int = 6) -> list[dict[str, Any]]:
    """Front-page Hacker News stories via the official Algolia API (keyless).

    Under HARMONIA_MOCK_AI=1 returns deterministic fixtures so the whole
    proactive loop runs offline.
    """
    if mock_ai_enabled():
        print("[MOCK-AI] fetch_signals: deterministic local fixtures", flush=True)
        return [dict(s) for s in _MOCK_SIGNALS[:limit]]
    with httpx.Client(timeout=20) as c:
        res = c.get(HN_FRONT_PAGE, params={"tags": "front_page", "hitsPerPage": limit})
        res.raise_for_status()
        hits = res.json().get("hits", [])
    return [
        {
            "title": h.get("title") or "",
            "url": h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID')}",
            "points": int(h.get("points") or 0),
            "comments": int(h.get("num_comments") or 0),
        }
        for h in hits
        if h.get("title")
    ]


_MOCK_SIGNALS = [
    {"title": "YC W25 batch shows AI agents replacing internal tools", "url": "https://news.ycombinator.com/item?id=8800001", "points": 412, "comments": 233},
    {"title": "Study: startups shipping weekly grow 2.3x faster", "url": "https://example.com/weekly-shipping-study", "points": 356, "comments": 187},
    {"title": "Show HN: I automated my founder content pipeline", "url": "https://news.ycombinator.com/item?id=8800003", "points": 298, "comments": 154},
    {"title": "Why usage-based pricing wins for AI products", "url": "https://example.com/usage-based-pricing", "points": 241, "comments": 132},
    {"title": "The death of the dashboard: agents act, humans approve", "url": "https://example.com/death-of-dashboard", "points": 198, "comments": 96},
    {"title": "Onboarding teardown: activation in 40 hours", "url": "https://example.com/onboarding-teardown", "points": 176, "comments": 88},
]


def watch_engagement() -> list[dict[str, Any]]:
    """Flags engagement outliers (>= OUTLIER_FACTOR x median likes) as ideas."""
    try:
        insights = get_insights()
    except WebApiError:
        logger.warning("engagement watch: insights feed unavailable")
        return []
    posts = [p for p in insights.get("topPosts", []) if p.get("likes") is not None]
    if len(posts) < 3:
        return []
    likes = sorted(int(p["likes"]) for p in posts)
    median = likes[len(likes) // 2]
    if median <= 0:
        return []
    out = []
    for p in posts:
        text = str(p.get("text", ""))
        if int(p["likes"]) >= max(median * OUTLIER_FACTOR, median + 10):
            out.append({
                "topic": f"Follow-up to our breakout post: {text[:120]}",
                "angle": "Double down on the pattern that clearly resonated",
                "reason": (
                    f"Post earned {p['likes']} likes vs a median of {median} across recent "
                    f"posts ({round(int(p['likes']) / median, 1)}x baseline); audiences want more of this."
                ),
                "sources": [],
                "suggestedPost": "",
            })
    return out


def submit_proposals(proposals: list[dict[str, Any]]) -> tuple[int, int]:
    """Submits proposals to the web inbox; returns (created, skipped)."""
    if not proposals:
        return 0, 0
    data = web_post("/api/internal/proposals", {"proposals": proposals})
    return int(data.get("created", 0)), int(data.get("skipped", 0))


def _prior_learnings_line(insights: dict[str, Any]) -> str:
    goals = insights.get("goals") or {}
    bits = []
    if goals.get("voice"):
        bits.append(f"brand voice: {goals['voice']}")
    for t in (goals.get("topics") or [])[:3]:
        bits.append(f"priority topic: {t}")
    return "; ".join(bits)


async def tick() -> dict[str, int]:
    """One proactive pass. Each leg fails independently and visibly."""
    created = skipped = 0

    # Leg 1: trend scan -> topic proposals
    try:
        signals = fetch_signals()
        if signals:
            try:
                insights = get_insights()
            except WebApiError:
                insights = {}
            result = content.propose_ideas(signals, prior_learnings=_prior_learnings_line(insights))
            c1, s1 = submit_proposals(build_proposals(result.get("ideas", []), "trend_scan"))
            created += c1
            skipped += s1
    except Exception as exc:  # noqa: BLE001 - logged visibly, retried next tick
        logger.warning("trend scan failed (%s); will retry next tick", exc)

    # Leg 2: engagement outliers -> follow-up proposals
    try:
        c2, s2 = submit_proposals(build_proposals(watch_engagement(), "engagement_watch"))
        created += c2
        skipped += s2
    except Exception as exc:  # noqa: BLE001
        logger.warning("engagement watch failed (%s); will retry next tick", exc)

    if created or skipped:
        logger.info("proactive tick: %d new proposal(s), %d duplicate(s) skipped", created, skipped)
    return {"created": created, "skipped": skipped}


def _run_loop() -> None:
    logger.info("proactive agent started (every %ss)", POLL_SECONDS)
    while True:
        try:
            asyncio.run(tick())
        except Exception:  # noqa: BLE001 - keep the loop alive
            logger.exception("proactive tick failed")
        time.sleep(POLL_SECONDS)


def start_background() -> None:
    threading.Thread(target=_run_loop, daemon=True).start()
