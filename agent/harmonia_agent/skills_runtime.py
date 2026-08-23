"""Skill-backed operator insight tools for the Harmonia ADK team.

Loads the filesystem skills in ``harmonia_agent/skills`` into one
``SkillToolset`` whose additional function tools are real data paths only:
the official Hacker News Algolia API and Harmonia's own authenticated web
internal API. No tool here can publish, approve, or mutate anything.
"""

from __future__ import annotations

import pathlib
from collections import defaultdict
from datetime import datetime
from typing import Any

from google.adk.skills import load_skill_from_dir
from google.adk.tools import FunctionTool, skill_toolset

from . import signals, web_client
from .mock_ai import mock_ai_enabled
from .telemetry import safe_attributes, tracer

SKILLS_DIR = pathlib.Path(__file__).parent / "skills"

_SKILL_NAMES = (
    "trend-scan",
    "job-status",
    "signal-watch",
    "posting-schedule",
    "engagement-insights",
)

_MOCK_INSIGHTS = {
    "topPosts": [
        {"postId": "1901", "text": "We cut onboarding from nine days to forty hours.", "likes": 214, "publishedAt": "2026-08-20T14:05:00Z"},
        {"postId": "1887", "text": "Agents act. Humans approve. That is the whole product.", "likes": 96, "publishedAt": "2026-08-18T09:30:00Z"},
        {"postId": "1802", "text": "Shipping weekly beats shipping perfect.", "likes": 51, "publishedAt": "2026-08-15T14:40:00Z"},
    ],
    "takeaways": {"topPostId": "1901", "pattern": "specific numbers outperform slogans"},
}

_MOCK_FEED = {
    "pendingItems": [],
    "jobHealth": {"active": 1, "failed": 0},
    "recentPublished": [
        {"postId": "1901", "publishedAt": "2026-08-20T14:05:00Z"},
        {"postId": "1887", "publishedAt": "2026-08-18T09:30:00Z"},
        {"postId": "1802", "publishedAt": "2026-08-15T14:40:00Z"},
    ],
}


# ---------- trend / watch tools ----------

def fetch_trend_signals(limit: int = 6) -> dict[str, Any]:
    """Fetch current front-page startup-tech stories from Hacker News."""
    with tracer().start_as_current_span("harmonia.skill.fetch_signals"):
        found = signals.fetch_signals(limit=max(1, min(int(limit), 10)))
    return {"signals": found, "count": len(found)}


def search_trend_signals(query: str, limit: int = 5) -> dict[str, Any]:
    """Search recent Hacker News stories for a topic or keyword."""
    with tracer().start_as_current_span("harmonia.skill.search_signals") as span:
        span.set_attributes(safe_attributes({"query.length": len(query or "")}))
        found = signals.search_signals((query or "").strip(), limit=max(1, min(int(limit), 10)))
    return {"query": query, "signals": found, "count": len(found)}


def _mock_insights() -> dict[str, Any]:
    import copy

    return copy.deepcopy(_MOCK_INSIGHTS)


def _mock_feed() -> dict[str, Any]:
    import copy

    return copy.deepcopy(_MOCK_FEED)


# ---------- harmonia-state read tools ----------

def get_engagement_insights() -> dict[str, Any]:
    """Read measured engagement outcomes for this workspace's published posts."""
    if mock_ai_enabled():
        return _mock_insights()
    data = web_client.get_insights()
    return {"topPosts": list(data.get("topPosts") or []), **{
        k: v for k, v in data.items() if k != "topPosts"
    }}


def get_operator_feed() -> dict[str, Any]:
    """Read the workspace feed: pending items, job health, goals, recent posts."""
    if mock_ai_enabled():
        return _mock_feed()
    return web_client.get_feed()


_JOB_STATUS_FIELDS = (
    "id", "title", "sourceType", "stage", "status", "error",
    "createdAt", "updatedAt",
)


def _summarize_job(job: dict[str, Any]) -> dict[str, Any]:
    summary = {field: job.get(field) for field in _JOB_STATUS_FIELDS}
    drafts = job.get("drafts") or []
    actions = job.get("actions") or []
    verifications = job.get("verifications") or []
    receipts = job.get("receipts") or []
    summary["draftCount"] = len(drafts)
    summary["actions"] = [
        {
            "id": a.get("id"),
            "type": a.get("type"),
            "status": a.get("status"),
            "requiresApproval": a.get("requiresApproval"),
        }
        for a in actions
    ]
    summary["verificationSummary"] = [
        {
            "actionId": v.get("actionId"),
            "verified": bool(v.get("verified")),
        }
        for v in verifications
    ]
    summary["receiptCount"] = len(receipts)
    return summary


def get_job_status(job_id: str) -> dict[str, Any]:
    """Read the live pipeline state of one content job by id."""
    job_id = str(job_id or "").strip()
    if not job_id:
        return {"found": False, "reason": "no job id supplied"}
    if mock_ai_enabled():
        return {"found": True, "job": _summarize_job({
            "id": job_id,
            "title": "Mock launch video",
            "sourceType": "youtube",
            "stage": "awaiting_approval",
            "status": "active",
            "drafts": [{"id": "d1"}],
            "actions": [{
                "id": "act1", "type": "publish_x_post",
                "status": "proposed", "requiresApproval": True,
            }],
            "verifications": [], "receipts": [],
        })}
    try:
        job = web_client.get_job(job_id)
    except web_client.WebApiError as exc:
        if exc.status == 404:
            return {"found": False, "reason": f"job {job_id} does not exist"}
        return {"found": False, "reason": f"job lookup failed ({exc.status})"}
    return {"found": True, "job": _summarize_job(job)}


# ---------- schedule derivation ----------

def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def suggest_posting_windows() -> dict[str, Any]:
    """Derive posting windows from this workspace's own measured post history.

    Returns windows only when at least three timestamped measured posts exist;
    otherwise returns an explicit insufficient-data result.
    """
    if mock_ai_enabled():
        insights = _mock_insights()
        feed = _mock_feed()
    else:
        insights = get_engagement_insights()
        feed = get_operator_feed()

    samples: list[dict[str, Any]] = []
    for post in insights.get("topPosts") or []:
        ts = _parse_ts(post.get("publishedAt"))
        likes = post.get("likes")
        if ts is not None and isinstance(likes, int):
            samples.append({"at": ts, "likes": likes, "postId": post.get("postId")})
    if len(samples) < 3:
        for entry in feed.get("recentPublished") or []:
            ts = _parse_ts(entry.get("publishedAt"))
            if ts is not None and entry.get("postId") not in {s["postId"] for s in samples}:
                samples.append({"at": ts, "likes": None, "postId": entry.get("postId")})

    measured = [s for s in samples if s["likes"] is not None]
    if len(measured) < 3:
        return {
            "windows": [],
            "insufficientData": True,
            "measuredPosts": len(measured),
            "missing": (
                "at least three published posts with recorded timestamps and "
                "engagement; publish more content so the learn loop can measure it"
            ),
        }

    by_hour: dict[int, list[int]] = defaultdict(list)
    for s in measured:
        by_hour[s["at"].hour].append(s["likes"])
    ranked = sorted(
        ((hour, sum(likes) / len(likes)) for hour, likes in by_hour.items()),
        key=lambda item: (-item[1], item[0]),
    )
    top_hours = ranked[:2]
    return {
        "windows": [
            {
                "hourUtc": hour,
                "window": f"{hour:02d}:00-{(hour + 1) % 24:02d}:00 UTC",
                "averageLikes": round(avg, 1),
                "sampleSize": len(by_hour[hour]),
            }
            for hour, avg in top_hours
        ],
        "insufficientData": False,
        "measuredPosts": len(measured),
        "basis": [
            {"postId": s["postId"], "hourUtc": s["at"].hour, "likes": s["likes"]}
            for s in measured
        ],
    }


_TOOLS = (
    fetch_trend_signals,
    search_trend_signals,
    get_engagement_insights,
    get_operator_feed,
    get_job_status,
    suggest_posting_windows,
)


def build_insight_skillset() -> skill_toolset.SkillToolset:
    """One SkillToolset covering all Harmonia insight skills plus their tools."""
    skills = [load_skill_from_dir(SKILLS_DIR / name) for name in _SKILL_NAMES]
    return skill_toolset.SkillToolset(
        skills=skills,
        additional_tools=[FunctionTool(tool) for tool in _TOOLS],
    )
