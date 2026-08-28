"""Deterministic offline fixtures for HARMONIA_MOCK_AI=1 (dev only).

Every generator here produces output that satisfies the exact JSON shapes the
real Gemini stages return, so downstream pipeline code cannot tell them apart.
Nothing in this module is reachable unless the operator explicitly sets
HARMONIA_MOCK_AI=1; with the flag unset all real model paths run unchanged.
"""

from __future__ import annotations

import os
import subprocess
import tempfile

MOCK_FLAG = "HARMONIA_MOCK_AI"

# Plausible startup-podcast lines cycled across mock transcript segments.
_SEG_LINES = [
    "Everyone told us onboarding had to take two weeks.",
    "We mapped every step and found eleven that were pure ceremony.",
    "Deleting them cut activation time from nine days to forty hours.",
    "The lesson: speed of time-to-value beats feature count.",
    "Our first ten customers all churned for the same reason.",
    "Pricing is a product decision, not an afterthought.",
    "We shipped the boring integration and retention doubled.",
    "Founders underestimate how much distribution is the product.",
]

_MOMENT_TITLES = [
    "Time-to-value collapse",
    "Eleven ceremonial steps",
    "Churn's single cause",
    "Distribution is the product",
]


def mock_ai_enabled() -> bool:
    """True only when HARMONIA_MOCK_AI=1 is explicitly set."""
    return os.environ.get(MOCK_FLAG) == "1"


def mock_transcribe(audio_len: int) -> dict:
    """Fixed segments derived from audio size (~24 KB/s m4a heuristic)."""
    duration = max(18.0, min(float(audio_len) / 24_000.0, 900.0))
    seg_len = 6.0
    count = max(3, int(duration / seg_len))
    segments = [
        {
            "id": f"mock-s{i + 1}",
            "startSec": round(i * seg_len, 1),
            "endSec": round(min((i + 1) * seg_len, duration), 1),
            "text": _SEG_LINES[i % len(_SEG_LINES)],
        }
        for i in range(count)
    ]
    return {"language": "en", "segments": segments, "mock": True}


def mock_analyze(input) -> dict:
    """Development-only analysis derived solely from the typed source package."""
    segments = [segment for segment in input.sourceSegments if segment.locator.kind == "time_range"][:4]
    moments = [{
        "id": f"mock-m{i + 1}", "title": _MOMENT_TITLES[i % len(_MOMENT_TITLES)],
        "startSec": segment.locator.startMs / 1000, "endSec": segment.locator.endMs / 1000,
        "hook": segment.text, "quote": segment.text,
        "sourceSegmentRefs": [segment.id], "visualEvidenceIds": [],
        "assumptions": [], "confidence": "high",
    } for i, segment in enumerate(segments)]
    angles = [{
        "id": "mock-a1", "angleType": "source_insight", "evidenceKind": "source", "title": "Source-backed lesson",
        "rationale": f"Develop the explicit lesson in {input.title} without adding outside facts.",
        "evidenceRefs": [moments[0]["id"] if moments else input.sourceSegments[0].id], "assumptions": [], "confidence": "high",
    }]
    return {
        "sourceDigest": input.sourceDigest,
        "summary": f"(mock) Bounded analysis of {input.title}.",
        "moments": moments, "angles": angles, "assumptions": [],
        "confidence": "high", "mock": True,
    }


def mock_drafts(title: str, analysis: dict) -> list[dict]:
    """3 X drafts ≤280 chars referencing moment/angle ids from the analysis."""
    moment_ids = [m["id"] for m in (analysis.get("moments") or [])]
    angle_ids = [a["id"] for a in (analysis.get("angles") or [])]
    m1 = moment_ids[0] if moment_ids else None
    t1 = angle_ids[0] if angle_ids else None
    m2 = moment_ids[1] if len(moment_ids) > 1 else m1
    drafts = [
        {
            "id": "mock-d1", "platform": "x",
            **({"momentId": m1} if m1 else {}),
            "text": "Speed of time-to-value beats feature count. We cut activation from nine days to forty hours by deleting steps — not adding them.",
        },
        {
            "id": "mock-d2", "platform": "x",
            **({"angleId": t1} if t1 else {}),
            "text": "Hot take: most onboarding steps exist because one customer once asked. Subtraction is the underrated growth strategy.",
        },
        {
            "id": "mock-d3", "platform": "x",
            **({"momentId": m2} if m2 else {}),
            "text": "Our first ten customers churned for the same reason. Fixing that one thing beat every roadmap item we shipped that quarter.",
        },
    ]
    for d in drafts:
        d["text"] = d["text"][:280]
    return drafts


def mock_generate_image(prompt: str) -> tuple[bytes, str]:
    """Renders a REAL local PNG via ffmpeg lavfi (testsrc2), no network."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        out = tf.name
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "testsrc2=s=1080x1080:rate=1:duration=1",
             "-frames:v", "1", "-f", "image2", out],
            check=True,
        )
        with open(out, "rb") as f:
            return f.read(), "image/png"
    finally:
        os.unlink(out)


def mock_plan_actions(drafts: list[dict]) -> dict:
    """The actions JSON the ADK planner would emit: publish per draft + pack."""
    actions: list[dict] = []
    for d in drafts:
        text = (d.get("text") or "").strip()
        if text:
            actions.append({"type": "publish_x_post", "text": text})
    actions.append({"type": "export_content_pack"})
    return {"actions": actions}


def mock_ask(question: str) -> str:
    """Deterministic liaison answer for offline dev; cites mock tool shapes."""
    return (
        "(mock) Insight agent offline. I would answer "
        f"'{question[:120]}' by calling fetch_trend_signals, "
        "get_engagement_insights, get_job_status, or suggest_posting_windows "
        "and citing only their live results."
    )
