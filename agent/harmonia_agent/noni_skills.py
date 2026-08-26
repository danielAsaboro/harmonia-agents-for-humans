"""Dedicated Google ADK writing skills and trace validation for Noni."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from google.adk.agents.context import Context
from google.adk.skills import load_skill_from_dir
from google.adk.tools import skill_toolset
from google.adk.tools.base_tool import BaseTool

NONI_SKILL_NAME = "noni-writing-skills"
NONI_SKILL_TRACE_KEY = "noni_writing_skill_trace"
NONI_SKILL_ROOT = Path(__file__).parent / "skills" / NONI_SKILL_NAME
NONI_SKILL_REFERENCES = (
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
)


def build_noni_writing_skillset() -> skill_toolset.SkillToolset:
    """Expose one filesystem skill and only its two read-only loading tools."""
    skill = load_skill_from_dir(NONI_SKILL_ROOT)
    if skill.frontmatter.name != NONI_SKILL_NAME:
        raise RuntimeError("Noni writing skill name does not match its runtime contract")
    return skill_toolset.SkillToolset(
        skills=[skill],
        tool_filter=["load_skill", "load_skill_resource"],
    )


def reset_noni_skill_trace(context: Context) -> None:
    context.state[NONI_SKILL_TRACE_KEY] = []


def record_noni_skill_tool(
    tool: BaseTool,
    args: dict[str, Any],
    context: Context,
    tool_response: dict[str, Any],
) -> None:
    trace = list(context.state.get(NONI_SKILL_TRACE_KEY) or [])
    trace.append({
        "sequence": len(trace) + 1,
        "name": tool.name,
        "args": dict(args),
    })
    context.state[NONI_SKILL_TRACE_KEY] = trace


def _skill_name(entry: dict[str, Any]) -> str | None:
    args = entry.get("args") or {}
    value = args.get("skill_name") or args.get("name")
    return value if isinstance(value, str) else None


def _resource_path(entry: dict[str, Any]) -> str | None:
    args = entry.get("args") or {}
    value = args.get("file_path")
    return value if isinstance(value, str) else None


def validate_noni_skill_trace(trace: list[dict[str, Any]]) -> None:
    """Fail closed unless Noni used only the exact writing skill and references."""
    if (
        not trace
        or trace[0].get("name") != "load_skill"
        or sum(item.get("name") == "load_skill" for item in trace) != 1
    ):
        raise ValueError("Noni must load noni-writing-skills exactly once first")
    if [item.get("sequence") for item in trace] != list(range(1, len(trace) + 1)):
        raise ValueError("Noni writing-skill trace sequence is invalid")
    if _skill_name(trace[0]) != NONI_SKILL_NAME:
        raise ValueError("Noni may load only noni-writing-skills")

    resource_paths: list[str] = []
    for item in trace[1:]:
        if item.get("name") != "load_skill_resource":
            raise ValueError(f"Noni used a prohibited tool: {item.get('name')}")
        if _skill_name(item) != NONI_SKILL_NAME:
            raise ValueError("Noni may load resources only from noni-writing-skills")
        path = _resource_path(item)
        if path not in NONI_SKILL_REFERENCES:
            raise ValueError(f"Noni loaded an unapproved resource: {path}")
        resource_paths.append(path)
    if not resource_paths:
        raise ValueError("Noni must load at least one writing reference")
    if len(resource_paths) != len(set(resource_paths)):
        raise ValueError("Noni loaded a duplicate writing reference")
