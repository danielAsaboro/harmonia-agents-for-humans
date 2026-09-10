"""Request-bound grounded research tools for Nimi, separate from filesystem skills."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


NIMI_RESEARCH_TRACE_KEY = "nimi_analysis_research_trace"
PUBLIC_SEARCH_TOOL = "nimi_gateway_search"
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
        if not value.startswith(("https://", "http://", "s3://")):
            raise ValueError("grounded source requires an HTTP(S) or S3 URI")
        return value


class GroundedAnalysisResearch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=1, max_length=100)
    mode: str = Field(pattern=r"^(public_web|private_index)$")
    query: str = Field(min_length=1, max_length=500)
    sources: list[GroundedAnalysisSource] = Field(min_length=1, max_length=8)






def build_nimi_search_tool(model: Any) -> Any:
    from .research import research_tool
    return research_tool(PUBLIC_SEARCH_TOOL, "analysis")



def build_nimi_agent_search_tool(model: Any, data_store_id: str) -> Any:
    from .research import research_tool
    if not data_store_id:
        raise ValueError("Knowledge base ID is required")
    return research_tool(PRIVATE_SEARCH_TOOL, "analysis", knowledge_base_id=data_store_id)



def reset_nimi_research_trace(callback_context: Any) -> None:
    callback_context.state[NIMI_RESEARCH_TRACE_KEY] = []


def is_nimi_research_tool(tool: Any) -> bool:
    return tool.name in {PUBLIC_SEARCH_TOOL, PRIVATE_SEARCH_TOOL}


def guard_nimi_research_tool(tool: Any) -> None:
    if not is_nimi_research_tool(tool):
        raise ValueError(f"Nimi used a prohibited research tool: {tool.name}")


def record_nimi_research_tool(tool: Any, args: dict[str, Any], tool_context: Any, tool_response: dict[str, Any]) -> None:
    trace = list(tool_context.state.get(NIMI_RESEARCH_TRACE_KEY) or [])
    trace.append({"sequence": len(trace) + 1, "name": tool.name, "args": dict(args), "response": tool_response})
    tool_context.state[NIMI_RESEARCH_TRACE_KEY] = trace


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
    from .research import validate_provider_sources
    validate_provider_sources(grounding_metadata, result.sources, mode=request.get("mode", "public_web"))
    evidence = {}
    for source in result.sources:
        if source.evidenceId in evidence:
            raise ValueError("Research returned duplicate evidence")
        evidence[source.evidenceId] = ( "private_context" if result.mode == "private_index" else "public_context", source.supportedText, source.title, source.url)
    return evidence
