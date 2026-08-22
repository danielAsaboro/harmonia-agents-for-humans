"""Deterministic offline fixtures for HARMONIA_MOCK_AI=1 (dev only).

Every generator here produces output that satisfies the exact JSON shapes the
real Gemini stages return, so downstream pipeline code cannot tell them apart.
Nothing in this module is reachable unless the operator explicitly sets
HARMONIA_MOCK_AI=1; with the flag unset all real model paths run unchanged.
"""

from __future__ import annotations

import os
import re
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


def _transcript_bound(transcript: str) -> float:
    """Last [Ns] timestamp in a formatted transcript; 0 when absent."""
    marks = [float(m) for m in re.findall(r"\[(\d+(?:\.\d+)?)s\]", transcript)]
    return max(marks) if marks else 0.0


def mock_analyze(title: str, channel: str, transcript: str, prior_learnings: str | None = None) -> dict:
    """Summary + 4 moments bounded by transcript length + 3 trend/2 meme angles."""
    bound = _transcript_bound(transcript)
    span = bound / 5 if bound > 0 else 0.0
    moments = []
    if bound > 0:
        for i in range(4):
            start = round(i * span + span * 0.2, 1)
            end = round(min((i + 1) * span - span * 0.1, bound), 1)
            moments.append({
                "id": f"mock-m{i + 1}",
                "title": _MOMENT_TITLES[i % len(_MOMENT_TITLES)],
                "startSec": min(start, bound),
                "endSec": max(end, min(start + 4.0, bound)),
                "hook": _SEG_LINES[(i + 1) % len(_SEG_LINES)],
                "quote": _SEG_LINES[i % len(_SEG_LINES)],
            })
    else:
        # Brief-style analysis carries key points with zero timestamps.
        for i in range(4):
            moments.append({
                "id": f"mock-m{i + 1}", "title": _SEG_LINES[i % len(_SEG_LINES)],
                "startSec": 0, "endSec": 0,
                "hook": _SEG_LINES[i % len(_SEG_LINES)], "quote": _SEG_LINES[i % len(_SEG_LINES)],
            })
    angles = [
        {"id": "mock-a1", "kind": "trend", "title": "Time-to-value over feature count", "rationale": f"Contrarian take on '{title}' that resonates with startup operators."},
        {"id": "mock-a2", "kind": "trend", "title": "Deletion as product strategy", "rationale": "Founders engage with 'what we removed' stories more than launch lists."},
        {"id": "mock-a3", "kind": "trend", "title": "Activation metrics teardown", "rationale": "Concrete before/after numbers invite quote-posts and replies."},
        {"id": "mock-a4", "kind": "meme", "title": "Onboarding obstacle course meme", "rationale": "Relatable joke format about multi-step signups ending in confetti."},
        {"id": "mock-a5", "kind": "meme", "title": "'It depends' founder meme", "rationale": f"Playful format pairing a shrug with the hardest lesson from {channel or 'the episode'}."},
    ]
    return {
        "summary": f"(mock) Analysis of '{title}': punchy startup lessons on activation speed and subtraction-led product strategy.",
        "moments": moments,
        "angles": angles,
        "mock": True,
    }


def mock_ideate(brief: str, prior_learnings: str | None = None) -> dict:
    """Same shape as analyze(); moments carry zero timestamps (no media timeline)."""
    result = mock_analyze(brief[:60], "operator", "")
    result["summary"] = f"(mock) Positioning summary for brief: {brief[:140]}"
    return result


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


def mock_propose_ideas(signals: list[dict]) -> dict:
    """2-3 topic proposals derived from signals, with reasons + sources."""
    ideas = []
    for s in signals[:3]:
        title = str(s.get("title", ""))[:140]
        url = str(s.get("url", ""))
        ideas.append({
            "topic": f"Founder take: {title}",
            "angle": "Contrarian operator perspective grounded in what we shipped this week",
            "reason": f"Currently front-page news ({s.get('points', 0)} points, {s.get('comments', 0)} comments) - high attention window for a credible founder response.",
            "sources": [url] if url else [],
            "suggestedPost": "",
        })
    return {"ideas": ideas}


def mock_propose_gap_fillers(goals_text: str, learnings_text: str) -> dict:
    """Ideas to fill calendar gaps, grounded in goals and past performance."""
    return {
        "ideas": [
            {
                "topic": "Teardown: one metric we moved this quarter and exactly how",
                "angle": "Numbers-first storytelling; matches your activation-time narrative",
                "reason": f"Calendar has open slots in the next 7 days and your audience rewards concrete before/after stories. Goals on file: {goals_text[:80] or 'consistent posting'}.",
                "sources": [],
                "suggestedPost": "",
            },
            {
                "topic": "Build-in-public update: what shipped this week and why it matters",
                "angle": "Weekly cadence anchor; low effort, high trust",
                "reason": f"Fills the gap while reinforcing consistency - your top posts came from operational honesty. {learnings_text[:100]}",
                "sources": [],
                "suggestedPost": "",
            },
        ]
    }


def mock_propose_recycle(post_text: str, likes: int) -> dict:
    """A refresh angle for an older top-performing post."""
    return {
        "ideas": [
            {
                "topic": f"Refresh of a proven winner: {post_text[:110]}",
                "angle": "Same core insight, new framing: what happened AFTER the original post",
                "reason": f"This post earned {likes} likes and is aging out of feeds. Evergreen winners deserve a second run with updated proof.",
                "sources": [],
                "suggestedPost": "",
            }
        ]
    }
