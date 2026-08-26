"""Separate contracts for Nimi's filesystem skill and grounded-research tools."""

from __future__ import annotations

import json
import asyncio
from types import SimpleNamespace

import pytest

from harmonia_agent.nimi_skills import (
    NIMI_SKILL_NAME,
    NIMI_SKILL_REFERENCES,
    build_nimi_analysis_skillset,
    guard_nimi_skill_tool,
    validate_nimi_skill_trace,
)
from harmonia_agent.nimi_research import (
    build_nimi_agent_search_tool,
    build_nimi_google_search_tool,
    validate_nimi_research_trace,
)


def _load_trace(reference: str | None = None) -> list[dict]:
    trace = [{
        "sequence": 1, "name": "load_skill",
        "args": {"skill_name": NIMI_SKILL_NAME},
    }]
    if reference:
        trace.append({
            "sequence": 2, "name": "load_skill_resource",
            "args": {"skill_name": NIMI_SKILL_NAME, "file_path": reference},
        })
    return trace


def _public_request() -> dict:
    return {
        "id": "analysis-research-1", "mode": "public_web",
        "question": "Is activation speed a current startup onboarding concern?",
        "justification": "Qualify the requested current trend angle without replacing source analysis.",
    }


def _public_response() -> dict:
    return {
        "requestId": "analysis-research-1", "mode": "public_web",
        "query": "startup onboarding activation speed",
        "sources": [{
            "evidenceId": "analysis-search-1", "title": "Activation research",
            "url": "https://example.com/activation", "supportedText": "Activation speed remains a startup onboarding concern.",
        }],
    }


def _public_metadata() -> dict:
    return {
        "webSearchQueries": ["startup onboarding activation speed"],
        "searchEntryPoint": {"renderedContent": "search"},
        "groundingChunks": [{"web": {"title": "Activation research", "uri": "https://example.com/activation"}}],
        "groundingSupports": [{
            "groundingChunkIndices": [0],
            "segment": {"text": "Activation speed remains a startup onboarding concern."},
        }],
    }


def test_nimi_exposes_only_one_filesystem_skill_and_approved_resources():
    tools = asyncio.run(build_nimi_analysis_skillset().get_tools())
    assert {tool.name for tool in tools} == {"load_skill", "load_skill_resource"}
    assert NIMI_SKILL_REFERENCES == (
        "references/evidence-observation-and-provenance.md",
        "references/moment-and-quote-extraction.md",
        "references/visual-and-clip-analysis.md",
        "references/themes-tensions-and-patterns.md",
        "references/angle-development.md",
        "references/performance-and-memory-interpretation.md",
        "references/uncertainty-and-analysis-critique.md",
    )


def test_nimi_trace_requires_exactly_one_skill_and_one_approved_reference():
    assert validate_nimi_skill_trace(_load_trace(NIMI_SKILL_REFERENCES[0])) is None
    with pytest.raises(ValueError, match="at least one analysis reference"):
        validate_nimi_skill_trace(_load_trace())
    duplicate = _load_trace(NIMI_SKILL_REFERENCES[0])
    duplicate.append({**duplicate[-1], "sequence": 3})
    with pytest.raises(ValueError, match="duplicate"):
        validate_nimi_skill_trace(duplicate)


def test_nimi_guard_rejects_unapproved_skill_resources_and_tools():
    with pytest.raises(ValueError, match="unapproved resource"):
        guard_nimi_skill_tool(
            SimpleNamespace(name="load_skill_resource"),
            {"skill_name": NIMI_SKILL_NAME, "file_path": "references/source-coverage.md"},
        )
    with pytest.raises(ValueError, match="prohibited skill tool"):
        guard_nimi_skill_tool(SimpleNamespace(name="publish"), {})


def test_search_is_not_accepted_as_part_of_the_skill_trace():
    trace = _load_trace(NIMI_SKILL_REFERENCES[0])
    trace.append({"sequence": 3, "name": "nimi_google_search_agent", "args": {}})
    with pytest.raises(ValueError, match="prohibited skill tool"):
        validate_nimi_skill_trace(trace)


def test_public_google_search_is_isolated_and_preserves_native_grounding():
    tool = build_nimi_google_search_tool("gemini-3.5-flash")
    assert tool.name == "nimi_google_search_agent"
    assert [item.name for item in tool.agent.tools] == ["google_search"]
    validate_nimi_skill_trace(_load_trace(NIMI_SKILL_REFERENCES[4]))
    research_trace = [{
        "sequence": 1, "name": "nimi_google_search_agent",
        "args": {"request": json.dumps(_public_request(), sort_keys=True)},
        "response": _public_response(),
    }]
    assert validate_nimi_research_trace(
        research_trace, research_request=_public_request(), grounding_metadata=_public_metadata(),
    ) == {"analysis-search-1": (
        "public_context", "Activation speed remains a startup onboarding concern.",
        "Activation research", "https://example.com/activation",
    )}


def test_public_search_rejects_cross_request_and_missing_native_metadata():
    trace = [{
        "sequence": 1, "name": "nimi_google_search_agent",
        "args": {"request": json.dumps(_public_request(), sort_keys=True)},
        "response": _public_response(),
    }]
    wrong = {**_public_request(), "id": "analysis-research-other"}
    with pytest.raises(ValueError, match="exact analysis research request"):
        validate_nimi_research_trace(trace, research_request=wrong, grounding_metadata=_public_metadata())
    with pytest.raises(ValueError, match="native grounding metadata"):
        validate_nimi_research_trace(trace, research_request=_public_request(), grounding_metadata=None)


def test_private_agent_search_is_isolated_and_requires_real_datastore():
    with pytest.raises(ValueError, match="datastore"):
        build_nimi_agent_search_tool("gemini-3.5-flash", "")
    tool = build_nimi_agent_search_tool(
        "gemini-3.5-flash",
        "projects/project-1/locations/global/collections/default_collection/dataStores/nimi-docs",
    )
    assert tool.name == "nimi_agent_search_agent"
    assert len(tool.agent.tools) == 1
    assert tool.agent.tools[0].__class__.__name__ == "VertexAiSearchTool"


def test_private_agent_search_preserves_request_bound_retrieval_metadata():
    request = {
        "id": "analysis-research-private", "mode": "private_index",
        "question": "What internal onboarding evidence qualifies the activation claim?",
        "justification": "The exact request requires tenant-scoped internal context.",
    }
    response = {
        "requestId": request["id"], "mode": request["mode"],
        "query": "internal onboarding activation evidence",
        "sources": [{
            "evidenceId": "analysis-search-private-1", "title": "Onboarding study",
            "url": "gs://tenant-research/onboarding", "supportedText": "Activation delays recur in onboarding.",
        }],
    }
    metadata = {
        "retrievalQueries": ["internal onboarding activation evidence"],
        "groundingChunks": [{"retrievedContext": {
            "title": "Onboarding study", "uri": "gs://tenant-research/onboarding",
            "text": "Activation delays recur in onboarding.",
        }}],
        "groundingSupports": [{
            "groundingChunkIndices": [0],
            "segment": {"text": "Activation delays recur in onboarding."},
        }],
    }
    trace = [{
        "sequence": 1, "name": "nimi_agent_search_agent",
        "args": {"request": request}, "response": response,
    }]
    assert validate_nimi_research_trace(
        trace, research_request=request, grounding_metadata=metadata,
    )["analysis-search-private-1"][0] == "private_context"


def test_search_is_forbidden_without_a_typed_request():
    trace = [{
        "sequence": 1, "name": "nimi_google_search_agent",
        "args": {"request": json.dumps(_public_request(), sort_keys=True)},
        "response": _public_response(),
    }]
    with pytest.raises(ValueError, match="without a supplied analysis research request"):
        validate_nimi_research_trace(trace, research_request=None, grounding_metadata=_public_metadata())
