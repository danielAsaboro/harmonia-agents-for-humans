"""Gemini-driven content stages: transcription, analysis, drafting."""

from __future__ import annotations

import json
import os
from typing import Any

from google import genai

from .config import settings
from .mock_ai import (
    mock_ai_enabled,
    mock_analyze,
    mock_drafts,
    mock_generate_image,
    mock_ideate,
    mock_propose_gap_fillers,
    mock_propose_ideas,
    mock_propose_recycle,
    mock_transcribe,
)

MODEL = "gemini-3.5-flash"
IMAGE_MODEL = os.environ.get("IMAGE_MODEL_ID", "gemini-3.5-flash-image")


def _client() -> genai.Client:
    key = settings().gemini_api_key
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not configured")
    return genai.Client(api_key=key)


def _parse_json(text: str) -> Any:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    return json.loads(cleaned)


def model_used() -> str:
    """Label recorded in persisted docs; honest about offline mode."""
    return "mock-local (HARMONIA_MOCK_AI)" if mock_ai_enabled() else MODEL


def transcribe_audio(audio: bytes, mime_type: str) -> dict:
    if mock_ai_enabled():
        print("[MOCK-AI] transcribe_audio: returning deterministic local fixture", flush=True)
        return mock_transcribe(len(audio))
    client = _client()
    res = client.models.generate_content(
        model=MODEL,
        contents=[
            {"role": "user", "parts": [
                {"inlineData": {"mimeType": mime_type, "data": __import__("base64").b64encode(audio).decode()}},
                {"text": "Transcribe this audio. Return JSON: {language, segments:[{id,startSec,endSec,text}]}. startSec/endSec are numbers."},
            ]},
        ],
    )
    return _parse_json(res.text)


def _prior_block(prior_learnings: str | None) -> str:
    if not prior_learnings:
        return ""
    return (
        "\nWhat performed well in earlier posts (optimize new ideas toward these patterns):\n"
        f"{prior_learnings[:4000]}\n"
    )


def analyze(title: str, channel: str, transcript: str, prior_learnings: str | None = None) -> dict:
    prompt = (
        f"Video: '{title}' by {channel}.\nTranscript:\n{transcript[:60000]}\n\n"
        + _prior_block(prior_learnings)
        + "Identify: 3-6 clip-worthy moments (startSec/endSec within video, punchy hook, exact quote), "
        "trend angles worth posting about, and meme angles (playful formats referencing the content). "
        "Return JSON: {summary, moments:[{id,title,startSec,endSec,hook,quote}], "
        "angles:[{id,kind:'trend'|'meme',title,rationale}]}"
    )
    if mock_ai_enabled():
        print("[MOCK-AI] analyze: returning deterministic local fixture", flush=True)
        return {k: v for k, v in mock_analyze(title, channel, transcript, prior_learnings).items() if k != "mock"}
    client = _client()
    res = client.models.generate_content(model=MODEL, contents=prompt)
    return _parse_json(res.text)


def ideate_from_brief(brief: str, prior_learnings: str | None = None) -> dict:
    """Concept jobs: research + ideation from an operator brief instead of video.
    Returns the same shape as analyze(); 'moments' carry key points with zero
    timestamps because there is no media timeline."""
    prompt = (
        "You are Harmonia's research & ideation engine for a startup's social media.\n"
        f"Operator brief:\n{brief[:20000]}\n\n"
        + _prior_block(prior_learnings)
        + "Produce: a summary of the positioning, 3-6 key points worth posting about "
        "(moments with startSec=0,endSec=0, hook = punchy takeaway, quote = supporting line), "
        "3-6 trend angles, and 2-4 meme angles (playful formats that fit the topic). "
        "Return JSON: {summary, moments:[{id,title,startSec,endSec,hook,quote}], "
        "angles:[{id,kind:'trend'|'meme',title,rationale}]}"
    )
    if mock_ai_enabled():
        print("[MOCK-AI] ideate_from_brief: returning deterministic local fixture", flush=True)
        return {k: v for k, v in mock_ideate(brief, prior_learnings).items() if k != "mock"}
    client = _client()
    res = client.models.generate_content(model=MODEL, contents=prompt)
    return _parse_json(res.text)


def draft_posts(title: str, analysis: dict) -> list[dict]:
    prompt = (
        f"Video: '{title}'.\nAnalysis JSON:\n{json.dumps(analysis)[:30000]}\n\n"
        "Draft platform posts. For X: max 280 chars, punchy startup-audience voice, no hashtags spam. "
        "Each post references one moment or angle by id when applicable. "
        'Return JSON: {drafts:[{id,platform:"x",momentId?,angleId?,text}]}'
    )
    if mock_ai_enabled():
        print("[MOCK-AI] draft_posts: returning deterministic local fixture", flush=True)
        return mock_drafts(title, analysis)
    client = _client()
    res = client.models.generate_content(model=MODEL, contents=prompt)
    return _parse_json(res.text)["drafts"]


class ImageGenError(RuntimeError):
    pass


def generate_image(prompt: str) -> tuple[bytes, str]:
    """Generates an image with Gemini. Returns (bytes, mime_type)."""
    if mock_ai_enabled():
        print("[MOCK-AI] generate_image: rendering real local PNG via ffmpeg lavfi", flush=True)
        return mock_generate_image(prompt)
    client = _client()
    try:
        res = client.models.generate_images(model=IMAGE_MODEL, contents=prompt)
        images = getattr(res, "generated_images", None)
        if not images:
            raise ImageGenError(f"{IMAGE_MODEL} returned no images")
        img = images[0].image
        return img.image_bytes, getattr(img, "mime_type", None) or "image/png"
    except ImageGenError:
        raise
    except Exception as exc:  # noqa: BLE001 - normalized for stage failure classification
        raise ImageGenError(f"image generation failed: {exc}") from exc


def propose_ideas(signals: list[dict], prior_learnings: str | None = None) -> dict:
    """Proactive ideation: turns external signals into topic proposals.

    Same output contract as the other stages:
    {ideas: [{topic, angle, reason, sources: [url], suggestedPost}]}
    """
    prompt = (
        "You are Harmonia's proactive content strategist. External signals "
        f"(JSON):\n{json.dumps(signals)[:20000]}\n\n"
        + _prior_block(prior_learnings)
        + "Propose 2-3 concrete social post topics for a startup founder. Each must: "
        "connect a signal to the founder's own experience, include a reason explaining "
        "why NOW (attention window), cite the signal URLs as sources, and optionally "
        "include a suggestedPost (max 280 chars). "
        "Return JSON: {ideas:[{topic,angle,reason,sources:[url],suggestedPost}]}"
    )
    if mock_ai_enabled():
        print("[MOCK-AI] propose_ideas: returning deterministic local fixture", flush=True)
        return mock_propose_ideas(signals)
    client = _client()
    res = client.models.generate_content(model=MODEL, contents=prompt)
    return _parse_json(res.text)


def propose_gap_fillers(goals_text: str, learnings_text: str) -> dict:
    """Calendar-gap ideation grounded in the operator's goals + own learnings."""
    prompt = (
        "You are Harmonia's content strategist filling gaps in a startup founder's "
        "posting calendar.\n"
        f"Operator goals: {goals_text[:4000]}\n"
        f"Past performance takeaways: {learnings_text[:4000]}\n\n"
        "Propose 2 concrete post topics that fit the founder's voice and reward "
        "patterns. Each needs topic, angle, reason (why it serves the goals), and "
        "optionally suggestedPost (max 280 chars). sources may be empty. "
        "Return JSON: {ideas:[{topic,angle,reason,sources:[],suggestedPost}]}"
    )
    if mock_ai_enabled():
        print("[MOCK-AI] propose_gap_fillers: returning deterministic local fixture", flush=True)
        return mock_propose_gap_fillers(goals_text, learnings_text)
    client = _client()
    res = client.models.generate_content(model=MODEL, contents=prompt)
    return _parse_json(res.text)


def propose_recycle(post_text: str, likes: int) -> dict:
    """A refresh angle for an older top-performing post."""
    prompt = (
        "A startup founder's social post performed exceptionally well but is aging "
        f"out of feeds.\nOriginal post: {post_text[:1000]}\nLikes at peak: {likes}\n\n"
        "Propose one refreshed re-post concept: same core insight, new framing or "
        "updated proof. Return JSON: {ideas:[{topic,angle,reason,sources:[],suggestedPost}]}"
    )
    if mock_ai_enabled():
        print("[MOCK-AI] propose_recycle: returning deterministic local fixture", flush=True)
        return mock_propose_recycle(post_text, likes)
    client = _client()
    res = client.models.generate_content(model=MODEL, contents=prompt)
    return _parse_json(res.text)


def build_content_pack(title: str, url: str, moments: list, angles: list, drafts: list) -> str:
    lines = [f"# Harmonia Content Pack — {title}", "", f"Source: {url}", ""]
    lines.append("## Clip moments")
    for m in moments:
        lines.append(f"- **{m['title']}** ({int(m['startSec'])}s–{int(m['endSec'])}s): {m['hook']}")
        lines.append(f'  > "{m["quote"]}"')
    lines.append("\n## Trend & meme angles")
    for a in angles:
        lines.append(f"- [{a['kind'].upper()}] {a['title']} — {a['rationale']}")
    lines.append("\n## Ready-to-post drafts")
    for d in drafts:
        lines.append(f"### {d['platform'].upper()}")
        lines.append(f"> {d['text']}")
    lines.append("\n---\nGenerated by Harmonia (Gemini + Google ADK).")
    return "\n".join(lines)
