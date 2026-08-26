"""Noni's bounded ADK writing-skill contract."""

import asyncio
from pathlib import Path

import pytest
from google.adk.tools import skill_toolset

from harmonia_agent.agents import build_agent_team
from harmonia_agent.noni_skills import (
    NONI_SKILL_NAME,
    NONI_SKILL_REFERENCES,
    build_noni_writing_skillset,
    validate_noni_skill_trace,
)


EXPECTED_REFERENCES = {
    "references/thought-leadership.md",
    "references/hooks-and-introductions.md",
    "references/structure-and-mece.md",
    "references/case-studies.md",
    "references/storytelling.md",
    "references/bad-content-diagnosis.md",
    "references/persuasion.md",
    "references/outlining.md",
    "references/titles-and-headlines.md",
    "references/convincing-content.md",
}


def test_noni_skill_is_valid_and_covers_all_ten_writing_topics():
    toolset = build_noni_writing_skillset()

    assert isinstance(toolset, skill_toolset.SkillToolset)
    assert [skill.frontmatter.name for skill in toolset.skills] == ["noni-writing-skills"]
    assert NONI_SKILL_NAME == "noni-writing-skills"
    assert set(NONI_SKILL_REFERENCES) == EXPECTED_REFERENCES
    root = Path(__file__).parents[1] / "harmonia_agent" / "skills" / NONI_SKILL_NAME
    assert all((root / relative).read_text().strip() for relative in EXPECTED_REFERENCES)
    coverage = (root / "references" / "coverage.md").read_text()
    assert all(relative.removeprefix("references/") in coverage for relative in EXPECTED_REFERENCES)


def test_noni_skillset_exposes_only_loading_tools_and_no_scripts_or_data_tools():
    tools = asyncio.run(build_noni_writing_skillset().get_tools())

    assert {tool.name for tool in tools} == {"load_skill", "load_skill_resource"}


def test_noni_agent_receives_exactly_the_dedicated_writing_skillset():
    noni = next(agent for agent in build_agent_team().sub_agents if agent.name == "noni_copywriter")

    assert len(noni.tools) == 1
    assert isinstance(noni.tools[0], skill_toolset.SkillToolset)
    assert [skill.frontmatter.name for skill in noni.tools[0].skills] == [NONI_SKILL_NAME]


def _trace(*resources: str) -> list[dict]:
    calls = [{"sequence": 1, "name": "load_skill", "args": {"skill_name": NONI_SKILL_NAME}}]
    calls.extend({
        "sequence": index + 2,
        "name": "load_skill_resource",
        "args": {"skill_name": NONI_SKILL_NAME, "file_path": resource},
    } for index, resource in enumerate(resources))
    return calls


def test_noni_trace_requires_one_skill_and_at_least_one_approved_reference():
    assert validate_noni_skill_trace(_trace("references/hooks-and-introductions.md")) is None

    with pytest.raises(ValueError, match="exactly once first"):
        validate_noni_skill_trace([])
    with pytest.raises(ValueError, match="at least one writing reference"):
        validate_noni_skill_trace(_trace())
    with pytest.raises(ValueError, match="unapproved resource"):
        validate_noni_skill_trace(_trace("references/unknown.md"))


@pytest.mark.parametrize("name", ["run_skill_script", "search_trend_signals", "get_operator_feed"])
def test_noni_trace_rejects_scripts_research_and_workspace_tools(name):
    calls = _trace("references/persuasion.md")
    calls.append({"sequence": 3, "name": name, "args": {}})

    with pytest.raises(ValueError, match="prohibited tool"):
        validate_noni_skill_trace(calls)


def test_noni_trace_rejects_wrong_skill_duplicate_resources_and_bad_sequence():
    wrong = _trace("references/storytelling.md")
    wrong[0]["args"]["skill_name"] = "trend-scan"
    with pytest.raises(ValueError, match="noni-writing-skills"):
        validate_noni_skill_trace(wrong)

    duplicate = _trace("references/storytelling.md", "references/storytelling.md")
    with pytest.raises(ValueError, match="duplicate"):
        validate_noni_skill_trace(duplicate)

    sequence = _trace("references/storytelling.md")
    sequence[1]["sequence"] = 4
    with pytest.raises(ValueError, match="sequence"):
        validate_noni_skill_trace(sequence)
