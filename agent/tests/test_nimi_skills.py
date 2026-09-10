"""Separate contracts for Nimi's filesystem skill and grounded-research tools."""

from __future__ import annotations

import json
import asyncio
from types import SimpleNamespace

import pytest

from harmonia_agent import nimi_skills
from harmonia_agent.nimi_skills import (
    NIMI_SKILL_NAME,
    NIMI_SKILL_REFERENCES,
    guard_nimi_skill_tool,
    validate_nimi_skill_trace,
)
from harmonia_agent.nimi_research import (
    build_nimi_agent_search_tool,
    build_nimi_search_tool,
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
    return {"provider": "agentcore_gateway", "responseSha256": "a"*64, "sources": _public_response()["sources"]}



def test_nimi_exposes_only_one_filesystem_skill_and_approved_resources():
    from harmonia_agent.agents import build_agent_team
    specialist = build_agent_team().find_sub_agent("nimi_analyst")
    assert specialist.tools == []
    assert "skill" in specialist.instruction.lower()
    assert specialist.input_schema is not None



def test_nimi_runtime_bootstraps_the_owned_skill_and_approved_references():
    context = SimpleNamespace(state={})

    nimi_skills.bootstrap_nimi_skill_context(context)

    validate_nimi_skill_trace(context.state["nimi_analysis_skill_trace"])
    assert "evidence analyst" in context.state["nimi_analysis_skill_context"].lower()
    assert all(reference in str(context.state["nimi_analysis_skill_trace"]) for reference in NIMI_SKILL_REFERENCES)


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
    trace.append({"sequence": 3, "name": "nimi_gateway_search", "args": {}})
    with pytest.raises(ValueError, match="prohibited skill tool"):
        validate_nimi_skill_trace(trace)


def test_public_google_search_is_isolated_and_preserves_native_grounding():
    tool = build_nimi_search_tool("gemini-3.5-flash")
    assert tool.tool_name == "nimi_gateway_search"
    assert tool.tool_spec["inputSchema"]["json"]["required"] == ["request"]
    validate_nimi_skill_trace(_load_trace(NIMI_SKILL_REFERENCES[4]))
    research_trace = [{
        "sequence": 1, "name": "nimi_gateway_search",
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
        "sequence": 1, "name": "nimi_gateway_search",
        "args": {"request": json.dumps(_public_request(), sort_keys=True)},
        "response": _public_response(),
    }]
    wrong = {**_public_request(), "id": "analysis-research-other"}
    with pytest.raises(ValueError, match="exact analysis research request"):
        validate_nimi_research_trace(trace, research_request=wrong, grounding_metadata=_public_metadata())
    with pytest.raises(ValueError, match="provider response"):
        validate_nimi_research_trace(trace, research_request=_public_request(), grounding_metadata=None)


def test_private_agent_search_is_isolated_and_requires_real_datastore():
    with pytest.raises(ValueError, match="Knowledge base"):
        build_nimi_agent_search_tool("gemini-3.5-flash", "")
    tool = build_nimi_agent_search_tool(
        "gemini-3.5-flash",
        "projects/project-1/locations/global/collections/default_collection/dataStores/nimi-docs",
    )
    assert tool.tool_name == "nimi_agent_search_agent"
    assert tool.tool_spec["inputSchema"]["json"]["required"] == ["request"]


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
            "url": "s3://tenant-research/onboarding", "supportedText": "Activation delays recur in onboarding.",
        }],
    }
    metadata = {"provider": "bedrock_knowledge_base", "responseSha256": "a"*64, "sources": response["sources"]}
    trace = [{
        "sequence": 1, "name": "nimi_agent_search_agent",
        "args": {"request": request}, "response": response,
    }]
    assert validate_nimi_research_trace(
        trace, research_request=request, grounding_metadata=metadata,
    )["analysis-search-private-1"][0] == "private_context"


def test_search_is_forbidden_without_a_typed_request():
    trace = [{
        "sequence": 1, "name": "nimi_gateway_search",
        "args": {"request": json.dumps(_public_request(), sort_keys=True)},
        "response": _public_response(),
    }]
    with pytest.raises(ValueError, match="without a supplied analysis research request"):
        validate_nimi_research_trace(trace, research_request=None, grounding_metadata=_public_metadata())
