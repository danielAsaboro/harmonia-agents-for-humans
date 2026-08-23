"""Live startup-tech signals from Hacker News via the official Algolia API.

Keyless and rate-limit friendly; used by proactive checks and the insight
skills so trend angles are grounded in current external evidence instead of
model recall. Under HARMONIA_MOCK_AI=1 returns deterministic fixtures so
checks and tests run offline.
"""

from __future__ import annotations

import httpx

from .mock_ai import mock_ai_enabled

HN_ALGOLIA_BASE = "https://hn.algolia.com/api/v1"

_MOCK_SIGNALS = [
    {"title": "YC W25 batch shows AI agents replacing internal tools", "url": "https://news.ycombinator.com/item?id=8800001", "points": 412, "comments": 233},
    {"title": "Study: startups shipping weekly grow 2.3x faster", "url": "https://example.com/weekly-shipping-study", "points": 356, "comments": 187},
    {"title": "Show HN: I automated my founder content pipeline", "url": "https://news.ycombinator.com/item?id=8800003", "points": 298, "comments": 154},
    {"title": "Why usage-based pricing wins for AI products", "url": "https://example.com/usage-based-pricing", "points": 241, "comments": 132},
    {"title": "The death of the dashboard: agents act, humans approve", "url": "https://example.com/death-of-dashboard", "points": 198, "comments": 96},
    {"title": "Onboarding teardown: activation in 40 hours", "url": "https://example.com/onboarding-teardown", "points": 176, "comments": 88},
]

_SEARCH_FIXTURES = {
    "agents": [
        {"title": "Agents that act: beyond chatbot demos", "url": "https://example.com/agents-that-act", "points": 305, "comments": 141},
        {"title": "Human approval gates for autonomous agents", "url": "https://example.com/approval-gates", "points": 188, "comments": 77},
        {"title": "Show HN: agent workflow engine on Firestore", "url": "https://example.com/agent-workflow-firestore", "points": 132, "comments": 51},
    ],
}


def _hit_to_signal(hit: dict) -> dict | None:
    title = hit.get("title") or (hit.get("story_title") or "")
    if not title:
        return None
    return {
        "title": title,
        "url": hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
        "points": int(hit.get("points") or 0),
        "comments": int(hit.get("num_comments") or 0),
    }


def fetch_signals(limit: int = 6) -> list[dict]:
    """Front-page Hacker News stories."""
    if mock_ai_enabled():
        return [dict(s) for s in _MOCK_SIGNALS[:limit]]
    with httpx.Client(timeout=20) as c:
        res = c.get(f"{HN_ALGOLIA_BASE}/search", params={"tags": "front_page", "hitsPerPage": limit})
        res.raise_for_status()
        hits = res.json().get("hits", [])
    return [s for s in (_hit_to_signal(h) for h in hits) if s]


def search_signals(query: str, limit: int = 5) -> list[dict]:
    """Keyword search over recent Hacker News stories (relevance-ranked)."""
    query = query.strip()
    if not query:
        return []
    if mock_ai_enabled():
        key = next((k for k in _SEARCH_FIXTURES if k in query.lower()), "agents")
        return [dict(s) for s in _SEARCH_FIXTURES[key][:limit]]
    with httpx.Client(timeout=20) as c:
        res = c.get(
            f"{HN_ALGOLIA_BASE}/search",
            params={"query": query, "tags": "story", "hitsPerPage": limit},
        )
        res.raise_for_status()
        hits = res.json().get("hits", [])
    return [s for s in (_hit_to_signal(h) for h in hits) if s]
