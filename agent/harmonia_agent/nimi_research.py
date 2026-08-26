"""Request-bound grounded research tools for Nimi, separate from filesystem skills."""

from __future__ import annotations

import json
import re
from typing import Any

from google.adk.agents import Agent
from google.adk.agents.context import Context
from google.adk.models.base_llm import BaseLlm
from google.adk.tools import VertexAiSearchTool, google_search
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from pydantic import BaseModel, ConfigDict, Field, field_validator

NIMI_RESEARCH_TRACE_KEY = "nimi_analysis_research_trace"
PUBLIC_SEARCH_TOOL = "nimi_google_search_agent"
PRIVATE_SEARCH_TOOL = "nimi_agent_search_agent"


class GroundedAnalysisSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidenceId: str = Field(pattern=r"^analysis-search-[A-Za-z0-9][A-Za-z0-9._:-]{0,82}$")
    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=3, max_length=2_000)
    supportedText: str = Field(min_length=1, max_length=1_000)

    @field_validator("url")
    @classmethod
    def require_source_uri(cls, value: str) -> str:
        if not value.startswith(("https://", "http://", "gs://")):
            raise ValueError("grounded source requires an HTTP(S) or GCS URI")
        return value


class GroundedAnalysisResearch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=1, max_length=100)
    mode: str = Field(pattern=r"^(public_web|private_index)$")
    query: str = Field(min_length=1, max_length=500)
    sources: list[GroundedAnalysisSource] = Field(min_length=1, max_length=8)


def _research_agent(*, name: str, model: str | BaseLlm, mode: str, search_tool: BaseTool) -> AgentTool:
    agent = Agent(
        name=name, model=model,
        description=f"Request-bound {mode} grounding for Nimi source analysis.",
        instruction=(
            "Use the supplied search tool only for the exact typed request. Return strict "
            "GroundedAnalysisResearch JSON with unchanged requestId and mode, actual query, "
            "stable analysis-search-* evidence IDs, titles, source URIs, and directly supported "
            "text. Do not analyze source media, invent research, define strategy, or authorize actions."
        ),
        tools=[search_tool], output_schema=GroundedAnalysisResearch,
        output_key="grounded_analysis_research", mode="single_turn",
    )
    return AgentTool(agent=agent, propagate_grounding_metadata=True)


def build_nimi_google_search_tool(model: str | BaseLlm) -> AgentTool:
    return _research_agent(name=PUBLIC_SEARCH_TOOL, model=model, mode="public_web", search_tool=google_search)


def build_nimi_agent_search_tool(model: str | BaseLlm, data_store_id: str) -> AgentTool:
    if not data_store_id or not data_store_id.startswith("projects/") or "/dataStores/" not in data_store_id:
        raise ValueError("Nimi Agent Search requires a real configured datastore resource")
    return _research_agent(
        name=PRIVATE_SEARCH_TOOL, model=model, mode="private_index",
        search_tool=VertexAiSearchTool(data_store_id=data_store_id),
    )


def reset_nimi_research_trace(context: Context) -> None:
    context.state[NIMI_RESEARCH_TRACE_KEY] = []


def is_nimi_research_tool(tool: BaseTool) -> bool:
    return tool.name in {PUBLIC_SEARCH_TOOL, PRIVATE_SEARCH_TOOL}


def guard_nimi_research_tool(tool: BaseTool) -> None:
    if not is_nimi_research_tool(tool):
        raise ValueError(f"Nimi used a prohibited research tool: {tool.name}")


def record_nimi_research_tool(tool: BaseTool, args: dict[str, Any], context: Context, tool_response: dict[str, Any]) -> None:
    trace = list(context.state.get(NIMI_RESEARCH_TRACE_KEY) or [])
    trace.append({"sequence": len(trace) + 1, "name": tool.name, "args": dict(args), "response": tool_response})
    context.state[NIMI_RESEARCH_TRACE_KEY] = trace


def _typed(value: Any) -> Any:
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def validate_nimi_research_trace(
    trace: list[dict[str, Any]], *, research_request: Any | None, grounding_metadata: Any | None,
) -> dict[str, tuple[str, ...]]:
    if research_request is None:
        if trace:
            raise ValueError("Nimi searched without a supplied analysis research request")
        return {}
    request = _typed(research_request)
    if not isinstance(request, dict) or len(trace) != 1 or trace[0].get("sequence") != 1:
        raise ValueError("Nimi must execute exactly one request-bound grounded research tool")
    call = trace[0]
    expected_tool = PUBLIC_SEARCH_TOOL if request.get("mode") == "public_web" else PRIVATE_SEARCH_TOOL
    if call.get("name") != expected_tool:
        raise ValueError("Nimi used the wrong grounding provider for the analysis request")
    call_request = (call.get("args") or {}).get("request")
    if isinstance(call_request, str):
        try:
            call_request = json.loads(call_request)
        except json.JSONDecodeError as exc:
            raise ValueError("Nimi search request must be exact typed JSON") from exc
    if call_request != request:
        raise ValueError("Nimi search must use the exact analysis research request")
    raw = call.get("response")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("Nimi grounded search returned invalid structured output") from exc
    try:
        result = GroundedAnalysisResearch.model_validate(raw)
    except ValueError as exc:
        raise ValueError("Nimi grounded search requires structured provenance") from exc
    if result.requestId != request.get("id") or result.mode != request.get("mode"):
        raise ValueError("Nimi search must bind to the exact analysis research request")
    request_terms = set(re.findall(r"[a-z0-9]+", str(request.get("question") or "").lower()))
    query_terms = set(re.findall(r"[a-z0-9]+", result.query.lower()))
    if not {term for term in request_terms if len(term) > 3}.intersection(query_terms):
        raise ValueError("Nimi search query is outside the analysis research request")
    metadata = _typed(grounding_metadata)
    if not isinstance(metadata, dict):
        raise ValueError("Nimi grounded search requires native grounding metadata")
    chunks = metadata.get("groundingChunks") or metadata.get("grounding_chunks") or []
    supports = metadata.get("groundingSupports") or metadata.get("grounding_supports") or []
    if request.get("mode") == "public_web":
        queries = metadata.get("webSearchQueries") or metadata.get("web_search_queries") or []
        entry_point = metadata.get("searchEntryPoint") or metadata.get("search_entry_point")
        if not queries or not entry_point:
            raise ValueError("Nimi public search requires queries and search entry-point metadata")
        context_key, evidence_kind = "web", "public_context"
    else:
        queries = metadata.get("retrievalQueries") or metadata.get("retrieval_queries") or []
        if not queries:
            raise ValueError("Nimi private search requires retrieval queries")
        context_key, evidence_kind = "retrievedContext", "private_context"
    evidence: dict[str, tuple[str, ...]] = {}
    for source in result.sources:
        indices = {
            index for index, chunk in enumerate(chunks)
            if isinstance(chunk, dict)
            and isinstance(chunk.get(context_key), dict)
            and chunk[context_key].get("title") == source.title
            and chunk[context_key].get("uri") == source.url
        }
        supported = any(
            isinstance(support, dict)
            and indices.intersection(support.get("groundingChunkIndices") or support.get("grounding_chunk_indices") or [])
            and source.supportedText in str((support.get("segment") or {}).get("text") or "")
            for support in supports
        )
        if not indices or not supported:
            raise ValueError("Nimi source is absent from native grounding metadata")
        if source.evidenceId in evidence:
            raise ValueError("Nimi search returned duplicate evidence")
        evidence[source.evidenceId] = (evidence_kind, source.supportedText, source.title, source.url)
    return evidence
