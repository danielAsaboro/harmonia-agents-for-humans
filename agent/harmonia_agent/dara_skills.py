"""Project-owned Strands editing skill and fail-closed resource trace for Dara."""

from __future__ import annotations

from pathlib import Path
from typing import Any


from .authority_records import skill_activation_records, validate_skill_activation

DARA_SKILL_NAME = "dara-editing-skills"
DARA_SKILL_TRACE_KEY = "dara_editing_skill_trace"
DARA_SKILL_ROOT = Path(__file__).parent / "skills" / DARA_SKILL_NAME
DARA_SKILL_REFERENCES = (
    "references/editorial-triage.md",
    "references/grounding-and-claims.md",
    "references/structure-and-clarity.md",
    "references/brief-voice-and-audience.md",
    "references/platform-cta-and-usability.md",
    "references/safety-and-inclusive-editing.md",
    "references/feedback-and-revision.md",
)
_LOAD_TOOLS = frozenset({"load_skill", "load_skill_resource"})
DARA_ARTIFACT_REFERENCES = (
    "references/editorial-triage.md",
    "references/grounding-and-claims.md",
)






def compiled_dara_artifact_skill_context() -> str:
    """Compile the approved static editing method without spending model turns."""
    instructions = (DARA_SKILL_ROOT / "SKILL.md").read_text()
    references = []
    for path in DARA_ARTIFACT_REFERENCES:
        name = path.removeprefix("references/")
        content = (DARA_SKILL_ROOT / path).read_text()
        if not content:
            raise RuntimeError(f"Dara compiled reference is missing: {path}")
        references.append(f"APPROVED REFERENCE {path}:\n{content}")
    return f"APPROVED SKILL {DARA_SKILL_NAME}:\n{instructions}\n\n" + "\n\n".join(references)


def activate_dara_artifact_skill(callback_context: Any) -> None:
    """Record the coordinator-side activation of the compiled, immutable skill."""
    callback_context.state[DARA_SKILL_TRACE_KEY] = skill_activation_records(
        skill_name=DARA_SKILL_NAME,
        skill_root=DARA_SKILL_ROOT,
        references=DARA_ARTIFACT_REFERENCES,
    )


def reset_dara_skill_trace(callback_context: Any) -> None:
    callback_context.state[DARA_SKILL_TRACE_KEY] = []


def _skill_name(args: dict[str, Any]) -> str | None:
    value = args.get("skill_name") or args.get("name")
    return value if isinstance(value, str) else None


def _resource_path(args: dict[str, Any]) -> str | None:
    value = args.get("file_path")
    return value if isinstance(value, str) else None


def guard_dara_skill_tool(tool: Any, args: dict[str, Any], tool_context: Any) -> None:
    if tool.name == "set_model_response":
        return
    del tool_context
    if tool.name not in _LOAD_TOOLS:
        raise ValueError(f"Dara used a prohibited tool: {tool.name}")
    if _skill_name(args) != DARA_SKILL_NAME:
        raise ValueError("Dara may load only dara-editing-skills")
    if tool.name == "load_skill_resource" and _resource_path(args) not in DARA_SKILL_REFERENCES:
        raise ValueError(f"Dara loaded an unapproved resource: {_resource_path(args)}")


def record_dara_skill_tool(
    tool: Any, args: dict[str, Any], tool_context: Any,
    tool_response: dict[str, Any],
) -> None:
    if tool.name == "set_model_response":
        return
    del tool_response
    trace = list(tool_context.state.get(DARA_SKILL_TRACE_KEY) or [])
    trace.append({"sequence": len(trace) + 1, "name": tool.name, "args": dict(args)})
    tool_context.state[DARA_SKILL_TRACE_KEY] = trace


def validate_dara_skill_trace(trace: list[dict[str, Any]]) -> dict[str, tuple[str, ...]]:
    if trace and trace[0].get("kind") == "skill_activation":
        validate_skill_activation(
            trace, skill_name=DARA_SKILL_NAME, skill_root=DARA_SKILL_ROOT,
            allowed_references=DARA_SKILL_REFERENCES,
        )
        return {}
    if (
        not trace or trace[0].get("name") != "load_skill"
        or sum(item.get("name") == "load_skill" for item in trace) != 1
    ):
        raise ValueError("Dara must load dara-editing-skills exactly once first")
    if [item.get("sequence") for item in trace] != list(range(1, len(trace) + 1)):
        raise ValueError("Dara editing-skill trace sequence is invalid")
    if _skill_name(trace[0].get("args") or {}) != DARA_SKILL_NAME:
        raise ValueError("Dara may load only dara-editing-skills")
    resources: list[str] = []
    for item in trace[1:]:
        if item.get("name") != "load_skill_resource":
            raise ValueError(f"Dara used a prohibited tool: {item.get('name')}")
        args = item.get("args") or {}
        if _skill_name(args) != DARA_SKILL_NAME:
            raise ValueError("Dara may load resources only from dara-editing-skills")
        path = _resource_path(args)
        if path not in DARA_SKILL_REFERENCES:
            raise ValueError(f"Dara loaded an unapproved resource: {path}")
        resources.append(path)
    if not resources:
        raise ValueError("Dara must load at least one editing reference")
    if len(resources) != len(set(resources)):
        raise ValueError("Dara loaded a duplicate editing reference")
    return {}


def compiled_dara_skill_context() -> str:
    return "PRELOADED dara skill and references. Do not call loaders.\n" + "\n\n".join(((DARA_SKILL_ROOT / "SKILL.md").read_text(), *((DARA_SKILL_ROOT / path).read_text() for path in DARA_SKILL_REFERENCES)))


def activate_dara_skill(callback_context: Any) -> None:
    callback_context.state[DARA_SKILL_TRACE_KEY] = skill_activation_records(skill_name=DARA_SKILL_NAME, skill_root=DARA_SKILL_ROOT, references=DARA_SKILL_REFERENCES)
