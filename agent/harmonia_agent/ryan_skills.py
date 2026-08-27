"""Project-owned ADK strategy skill and fail-closed resource trace for Ryan."""

from __future__ import annotations

from pathlib import Path
import json
import re
from typing import Any

from google.adk.agents import Agent
from google.adk.models.base_llm import BaseLlm
from google.adk.agents.context import Context
from google.adk.skills import load_skill_from_dir
from google.adk.tools import google_search, skill_toolset
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from pydantic import BaseModel, ConfigDict, Field, field_validator

RYAN_SKILL_NAME = "ryan-strategy-skills"
RYAN_SKILL_TRACE_KEY = "ryan_strategy_skill_trace"
RYAN_SKILL_ROOT = Path(__file__).parent / "skills" / RYAN_SKILL_NAME
RYAN_SKILL_REFERENCES = (
    "references/strategic-diagnosis.md",
    "references/positioning-and-thesis.md",
    "references/campaign-and-portfolio.md",
    "references/channels-formats-and-cadence.md",
    "references/funnel-cta-and-measurement.md",
    "references/source-grounded-briefs.md",
    "references/evidence-learning-and-revision.md",
)
_LOAD_TOOLS = frozenset({"load_skill", "load_skill_resource"})
_SEARCH_TOOL = "ryan_google_search_agent"


def build_ryan_strategy_skillset() -> skill_toolset.SkillToolset:
    """Expose one filesystem skill and only its bounded resource loaders."""
    skill = load_skill_from_dir(RYAN_SKILL_ROOT)
    if skill.frontmatter.name != RYAN_SKILL_NAME:
        raise RuntimeError("Ryan strategy skill name does not match its runtime contract")
    return skill_toolset.SkillToolset(
        skills=[skill],
        tool_filter=sorted(_LOAD_TOOLS),
    )


class GroundedStrategySource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidenceId: str = Field(pattern=r"^search-[A-Za-z0-9][A-Za-z0-9._:-]{0,92}$")
    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=8, max_length=2_000)
    supportedText: str = Field(min_length=1, max_length=1_000)

    @field_validator("url")
    @classmethod
    def require_public_url(cls, value: str) -> str:
        if not value.startswith(("https://", "http://")):
            raise ValueError("grounded source URL must be public HTTP(S)")
        return value


class GroundedStrategyResearch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=1, max_length=100)
    query: str = Field(min_length=1, max_length=500)
    sources: list[GroundedStrategySource] = Field(min_length=1, max_length=8)


def build_ryan_google_search_tool(model: str | BaseLlm) -> AgentTool:
    """Isolate native Google Search from Ryan's filesystem and function tools."""
    agent = Agent(
        name=_SEARCH_TOOL,
        model=model,
        description="Native Google Search grounding for one exact Ryan strategy research request.",
        instruction=(
            "Use google_search only for the exact request ID, question, and justification supplied. "
            "Prefer primary sources and current information. Return strict GroundedStrategyResearch "
            "JSON with the unchanged requestId, actual query, stable search-* evidence IDs, titles, "
            "URLs, and only directly supported text. Never analyze Harmonia's private source, invent "
            "customer research, change strategy, authorize an action, or access private data."
        ),
        tools=[google_search],
        output_schema=GroundedStrategyResearch,
        output_key="grounded_strategy_research",
        mode="single_turn",
    )
    return AgentTool(agent=agent, propagate_grounding_metadata=True)


def reset_ryan_skill_trace(callback_context: Context) -> None:
    callback_context.state[RYAN_SKILL_TRACE_KEY] = []


def _skill_name(args: dict[str, Any]) -> str | None:
    value = args.get("skill_name") or args.get("name")
    return value if isinstance(value, str) else None


def _resource_path(args: dict[str, Any]) -> str | None:
    value = args.get("file_path")
    return value if isinstance(value, str) else None


def guard_ryan_skill_tool(
    tool: BaseTool, args: dict[str, Any], tool_context: Context,
) -> None:
    """Reject disallowed loaders and paths before ADK reads the resource."""
    del tool_context
    if tool.name not in {*_LOAD_TOOLS, _SEARCH_TOOL}:
        raise ValueError(f"Ryan used a prohibited tool: {tool.name}")
    if tool.name == _SEARCH_TOOL:
        return
    if _skill_name(args) != RYAN_SKILL_NAME:
        raise ValueError("Ryan may load only ryan-strategy-skills")
    if tool.name == "load_skill_resource" and _resource_path(args) not in RYAN_SKILL_REFERENCES:
        raise ValueError(f"Ryan loaded an unapproved resource: {_resource_path(args)}")


def record_ryan_skill_tool(
    tool: BaseTool,
    args: dict[str, Any],
    tool_context: Context,
    tool_response: dict[str, Any],
) -> None:
    """Record only loader identity and arguments; skill prose is not evidence."""
    trace = list(tool_context.state.get(RYAN_SKILL_TRACE_KEY) or [])
    entry = {
        "sequence": len(trace) + 1,
        "name": tool.name,
        "args": dict(args),
    }
    if tool.name == _SEARCH_TOOL:
        entry["response"] = tool_response
    trace.append(entry)
    tool_context.state[RYAN_SKILL_TRACE_KEY] = trace


def validate_ryan_skill_trace(
    trace: list[dict[str, Any]], *, research_request: Any | None = None,
    grounding_metadata: Any | None = None,
) -> dict[str, tuple[str, ...]]:
    """Fail closed unless Ryan loaded one skill and approved references only."""
    if (
        not trace
        or trace[0].get("name") != "load_skill"
        or sum(item.get("name") == "load_skill" for item in trace) != 1
    ):
        raise ValueError("Ryan must load ryan-strategy-skills exactly once first")
    if [item.get("sequence") for item in trace] != list(range(1, len(trace) + 1)):
        raise ValueError("Ryan strategy-skill trace sequence is invalid")
    if _skill_name(trace[0].get("args") or {}) != RYAN_SKILL_NAME:
        raise ValueError("Ryan may load only ryan-strategy-skills")

    resources: list[str] = []
    search_calls: list[dict[str, Any]] = []
    research_started = False
    for item in trace[1:]:
        if item.get("name") == _SEARCH_TOOL:
            research_started = True
            search_calls.append(item)
            continue
        if item.get("name") != "load_skill_resource":
            raise ValueError(f"Ryan used a prohibited tool: {item.get('name')}")
        if research_started:
            raise ValueError("Ryan must load strategy references before public research")
        args = item.get("args") or {}
        if _skill_name(args) != RYAN_SKILL_NAME:
            raise ValueError("Ryan may load resources only from ryan-strategy-skills")
        path = _resource_path(args)
        if path not in RYAN_SKILL_REFERENCES:
            raise ValueError(f"Ryan loaded an unapproved resource: {path}")
        resources.append(path)
    if not resources:
        raise ValueError("Ryan must load at least one strategy reference")
    if len(resources) != len(set(resources)):
        raise ValueError("Ryan loaded a duplicate strategy reference")
    if research_request is None:
        if search_calls:
            raise ValueError("Ryan searched without a supplied strategy research request")
        return {}
    request = (
        research_request.model_dump(mode="json")
        if hasattr(research_request, "model_dump") else research_request
    )
    if not isinstance(request, dict) or len(search_calls) != 1:
        raise ValueError("Ryan must execute exactly one request-bound search")
    call = search_calls[0]
    call_request = (call.get("args") or {}).get("request")
    if isinstance(call_request, str):
        try:
            call_request = json.loads(call_request)
        except json.JSONDecodeError as exc:
            raise ValueError("Ryan search request must be exact typed JSON") from exc
    if call_request != request:
        raise ValueError("Ryan search must use the exact strategy research request")
    raw = call.get("response")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("Ryan native search returned invalid structured output") from exc
    try:
        result = GroundedStrategyResearch.model_validate(raw)
    except ValueError as exc:
        raise ValueError("Ryan native search requires structured provenance") from exc
    if result.requestId != request.get("id"):
        raise ValueError("Ryan search must bind to the exact strategy research request")
    request_terms = set(re.findall(r"[a-z0-9]+", str(request.get("question") or "").lower()))
    query_terms = set(re.findall(r"[a-z0-9]+", result.query.lower()))
    if not {term for term in request_terms if len(term) > 3}.intersection(query_terms):
        raise ValueError("Ryan search query is outside the strategy research request")
    metadata = (
        grounding_metadata.model_dump(mode="json", by_alias=True)
        if hasattr(grounding_metadata, "model_dump") else grounding_metadata
    )
    if not isinstance(metadata, dict):
        raise ValueError("Ryan native search requires native grounding metadata")
    chunks = metadata.get("groundingChunks") or metadata.get("grounding_chunks") or []
    supports = metadata.get("groundingSupports") or metadata.get("grounding_supports") or []
    queries = metadata.get("webSearchQueries") or metadata.get("web_search_queries") or []
    entry_point = metadata.get("searchEntryPoint") or metadata.get("search_entry_point")
    if not queries or not entry_point:
        raise ValueError("Ryan native search requires queries and search entry-point metadata")
    evidence: dict[str, tuple[str, ...]] = {}
    for source in result.sources:
        indices = {
            index for index, chunk in enumerate(chunks)
            if isinstance(chunk, dict) and isinstance(chunk.get("web"), dict)
            and chunk["web"].get("uri") == source.url
            and chunk["web"].get("title") == source.title
        }
        supported = any(
            isinstance(support, dict)
            and indices.intersection(support.get("groundingChunkIndices") or support.get("grounding_chunk_indices") or [])
            and source.supportedText in str((support.get("segment") or {}).get("text") or "")
            for support in supports
        )
        if not indices or not supported:
            raise ValueError("Ryan source is absent from native grounding metadata")
        if source.evidenceId in evidence:
            raise ValueError("Ryan search returned duplicate evidence")
        evidence[source.evidenceId] = (source.supportedText, source.title, source.url)
    return evidence
