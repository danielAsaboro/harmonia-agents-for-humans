"""Skill definitions and their real backing tools (offline dev mode only)."""

from __future__ import annotations

import pytest

from harmonia_agent import skills_runtime
from harmonia_agent.mock_ai import MOCK_FLAG


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setenv(MOCK_FLAG, "1")


def test_all_skills_are_valid_and_discoverable():
    skillset = skills_runtime.build_insight_skillset()
    names = {skill.frontmatter.name for skill in skillset.skills}
    assert names == set(skills_runtime._SKILL_NAMES)
    for skill in skillset.skills:
        assert len(skill.frontmatter.name) <= 64
        assert "-" not in (skill.frontmatter.name[0], skill.frontmatter.name[-1])
        assert 0 < len(skill.frontmatter.description) <= 1024
        assert skill.instructions.strip()


def test_skill_tools_are_read_only():
    skillset = skills_runtime.build_insight_skillset()
    tool_names = {
        tool.name
        for skill in skillset.skills
        for tool in getattr(skillset, "_SkillToolset__tools", []) or []
    } | {
        tool.__name__
        for tool in skills_runtime._TOOLS
    }
    assert {"fetch_trend_signals", "search_trend_signals", "get_engagement_insights",
            "get_operator_feed", "get_job_status", "suggest_posting_windows"} <= tool_names


def test_fetch_trend_signals_returns_mock_fixtures_offline():
    result = skills_runtime.fetch_trend_signals(limit=3)
    assert result["count"] == 3
    assert all(s["title"] and s["url"].startswith("http") for s in result["signals"])


def test_search_trend_signals_ignores_blank_queries():
    assert skills_runtime.search_trend_signals("   ") == {"query": "   ", "signals": [], "count": 0}


def test_job_status_summary_never_leaks_internal_fields():
    summary = skills_runtime.get_job_status("job-123")["job"]
    assert summary["stage"] == "awaiting_approval"
    assert "accessToken" not in str(summary)
    assert summary["actions"][0]["requiresApproval"] is True


def test_job_status_reports_missing_jobs_honestly():
    result = skills_runtime.get_job_status(" ")
    assert result == {"found": False, "reason": "no job id supplied"}


def test_posting_windows_derive_only_from_measured_history():
    result = skills_runtime.suggest_posting_windows()
    assert result["insufficientData"] is False
    assert result["measuredPosts"] == 3
    hours = [w["hourUtc"] for w in result["windows"]]
    assert hours[0] == 14  # two measured posts at 14:UTC outperform one at 9:UTC
    assert all(w["sampleSize"] >= 1 for w in result["windows"])


def test_posting_windows_fail_closed_without_measured_posts(monkeypatch):
    monkeypatch.setattr(
        skills_runtime,
        "_mock_insights",
        lambda: {"topPosts": [{"postId": "1", "text": "x"}]},
    )
    result = skills_runtime.suggest_posting_windows()
    assert result["insufficientData"] is True
    assert result["measuredPosts"] == 0
    assert "published posts" in result["missing"]


def test_insight_reads_stay_within_workspace_tools():
    feed = skills_runtime.get_operator_feed()
    insights = skills_runtime.get_engagement_insights()
    assert "recentPublished" in feed
    assert insights["topPosts"][0]["likes"] > insights["topPosts"][1]["likes"]
