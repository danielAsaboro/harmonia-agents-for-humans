"""Proactive agent unit tests: proposals, outlier detection, mock routing."""

import pytest

from harmonia_agent import content, proactive
from harmonia_agent.mock_ai import MOCK_FLAG


@pytest.fixture(autouse=True)
def _mock_on(monkeypatch):
    monkeypatch.setenv(MOCK_FLAG, "1")


def test_proposal_ids_deterministic_and_unique():
    ideas = [{"topic": "same topic"}, {"topic": "same topic"}]
    props = proactive.build_proposals(ideas, "trend_scan")
    assert len(props) == 1  # deduped within a batch
    assert props[0]["id"] == proactive._proposal_id("trend_scan", "same topic")
    assert props[0]["id"].startswith("prop-")
    again = proactive.build_proposals([{"topic": "same topic"}], "trend_scan")
    assert again[0]["id"] == props[0]["id"]


def test_build_proposals_caps_and_cleans():
    ideas = [
        {"topic": f"topic {i}", "sources": [f"https://s.example/{i}"] * 8}
        for i in range(6)
    ]
    props = proactive.build_proposals(ideas, "trend_scan")
    assert len(props) == proactive.MAX_PROPOSALS_PER_TICK
    for p in props:
        assert len(p["sources"]) <= 5
        assert set(p) == {"id", "source", "topic", "angle", "reason", "sources", "suggestedPost"}


def test_fetch_signals_mock_needs_no_network():
    signals = proactive.fetch_signals()
    assert len(signals) >= 3
    for s in signals:
        assert {"title", "url", "points", "comments"} <= set(s)
        assert s["url"].startswith("http")


def test_content_propose_ideas_routes_to_mock():
    result = content.propose_ideas(proactive.fetch_signals())
    assert set(result) >= {"ideas"}
    for idea in result["ideas"]:
        assert idea["topic"] and idea["reason"]
        assert isinstance(idea["sources"], list)


def test_watch_engagement_flags_outliers(monkeypatch):
    posts = [
        {"likes": 300, "text": "breakout post"},
        {"likes": 40, "text": "normal post"},
        {"likes": 20, "text": "quiet post"},
        {"likes": 30, "text": "another quiet one"},
    ]
    monkeypatch.setattr(proactive, "get_insights", lambda: {"topPosts": posts})
    ideas = proactive.watch_engagement()
    assert len(ideas) == 1
    assert "breakout post" in ideas[0]["topic"]
    assert "median of 40" in ideas[0]["reason"]
    assert "7.5x baseline" in ideas[0]["reason"]


def test_watch_engagement_quiet_when_few_posts(monkeypatch):
    monkeypatch.setattr(proactive, "get_insights", lambda: {"topPosts": [{"likes": 5, "text": "only"}]})
    assert proactive.watch_engagement() == []


def test_watch_engagement_handles_feed_failure(monkeypatch):
    from harmonia_agent.web_client import WebApiError

    def _boom():
        raise WebApiError("feed down", 500)

    monkeypatch.setattr(proactive, "get_insights", _boom)
    assert proactive.watch_engagement() == []
