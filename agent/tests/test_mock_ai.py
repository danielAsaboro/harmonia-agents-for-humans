"""Shape guarantees for HARMONIA_MOCK_AI / HARMONIA_MOCK_X fixtures.

The mock generators must satisfy the exact JSON shapes the real Gemini/X
paths produce, so downstream pipeline code cannot tell them apart.
"""

import pytest

from harmonia_agent import content, x_client
from harmonia_agent.mock_ai import (
    MOCK_FLAG,
    mock_ai_enabled,
    mock_analyze,
    mock_drafts,
    mock_generate_image,
    mock_ideate,
    mock_plan_actions,
    mock_transcribe,
)


@pytest.fixture(autouse=True)
def _mock_on(monkeypatch):
    monkeypatch.setenv(MOCK_FLAG, "1")


def test_flag_requires_explicit_set(monkeypatch):
    monkeypatch.delenv(MOCK_FLAG, raising=False)
    assert mock_ai_enabled() is False
    monkeypatch.setenv(MOCK_FLAG, "0")
    assert mock_ai_enabled() is False
    monkeypatch.setenv(MOCK_FLAG, "1")
    assert mock_ai_enabled() is True


def test_transcribe_segments_contiguous_and_marked():
    result = mock_transcribe(600_000)
    assert result["mock"] is True
    assert result["language"] == "en"
    segs = result["segments"]
    assert len(segs) >= 3
    for prev, nxt in zip(segs, segs[1:]):
        assert abs(prev["endSec"] - nxt["startSec"]) < 0.01
    for s in segs:
        assert s["endSec"] > s["startSec"] >= 0
        assert set(s) == {"id", "startSec", "endSec", "text"}


def test_content_transcribe_routes_to_mock():
    result = content.transcribe_audio(b"x" * 1000, "audio/mp4")
    assert result["mock"] is True


def test_analyze_shape_and_timestamp_bounds():
    transcript = "\n".join(f"[{t}s] line {t}" for t in range(0, 60, 6))
    result = mock_analyze("Some talk", "Chan", transcript)
    assert set(result) >= {"summary", "moments", "angles"}
    assert 3 <= len(result["moments"]) <= 6
    bound = 54.0
    for m in result["moments"]:
        assert set(m) == {"id", "title", "startSec", "endSec", "hook", "quote"}
        assert 0 <= m["startSec"] < m["endSec"] <= bound
    kinds = [a["kind"] for a in result["angles"]]
    assert kinds.count("trend") >= 3 and kinds.count("meme") >= 2
    for a in result["angles"]:
        assert set(a) == {"id", "kind", "title", "rationale"}


def test_ideate_from_brief_has_zero_timestamps():
    result = mock_ideate("Announce our usage-based billing launch for AI agent workloads.")
    for m in result["moments"]:
        assert m["startSec"] == 0 and m["endSec"] == 0


def test_drafts_reference_ids_and_fit_limit():
    analysis = mock_analyze("T", "C", "[0s] hello [30s] world [54s] end")
    drafts = mock_drafts("T", analysis)
    assert len(drafts) == 3
    valid_refs = {m["id"] for m in analysis["moments"]} | {a["id"] for a in analysis["angles"]}
    for d in drafts:
        assert d["platform"] == "x"
        assert len(d["text"]) <= 280
        refs = {d.get("momentId"), d.get("angleId")} - {None}
        assert refs <= valid_refs


def test_generate_image_returns_real_png():
    data, mime = mock_generate_image("a meme about onboarding")
    assert mime == "image/png"
    assert data[:8] == b"\x89PNG\r\n\x1a\n"  # real PNG signature
    assert len(data) > 10_000


def test_plan_actions_shape():
    plan = mock_plan_actions([{"text": "hello"}])
    assert {"actions"} == set(plan)
    assert plan["actions"][0] == {"type": "publish_x_post", "text": "hello"}
    assert plan["actions"][-1] == {"type": "export_content_pack"}


def test_mock_x_payloads_deterministic(monkeypatch):
    monkeypatch.setenv("HARMONIA_MOCK_X", "1")
    p1 = x_client.publish_post("same text")
    p2 = x_client.publish_post("same text")
    assert p1 == p2
    assert p1["id"].startswith("mock-")
    assert p1["url"] == f"https://x.com/i/web/status/{p1['id']}"
    post = x_client.get_post(p1["id"])
    assert post is not None and post["id"] == p1["id"]
    m1 = x_client.get_post_metrics(p1["id"])
    m2 = x_client.get_post_metrics(p1["id"])
    assert m1 == m2
    assert set(m1) == {"likes", "replies", "reposts", "quotes", "impressions"}


def test_real_x_still_fails_honestly_without_workspace_connection(monkeypatch):
    monkeypatch.delenv("HARMONIA_MOCK_X", raising=False)
    with pytest.raises(x_client.XError):
        x_client.publish_post("should fail without credentials")


def test_model_used_label_is_honest(monkeypatch):
    assert content.model_used().startswith("mock-local")
    monkeypatch.delenv(MOCK_FLAG, raising=False)
    assert content.model_used() == content.MODEL
