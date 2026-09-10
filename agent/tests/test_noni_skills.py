"""Noni's bounded ADK writing-skill contract."""

import asyncio
from pathlib import Path

import pytest

from harmonia_agent.agents import build_agent_team
from harmonia_agent.noni_skills import (
    NONI_SKILL_NAME,
    NONI_SKILL_REFERENCES,
    validate_noni_skill_trace,
)
from harmonia_agent import noni_skills


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
    "references/short-form-video-scripts.md",
}


def test_noni_skill_is_valid_and_covers_all_registered_writing_topics():
    from harmonia_agent.agents import build_agent_team
    from harmonia_agent.noni_skills import NONI_SKILL_ROOT
    specialist = build_agent_team().find_sub_agent("noni_copywriter")
    assert NONI_SKILL_NAME in specialist.instruction
    assert all((NONI_SKILL_ROOT / path).read_text().strip() for path in NONI_SKILL_REFERENCES)
    assert not any(tool.tool_name in {"load_skill", "load_skill_resource"} for tool in specialist.tools)



def test_noni_skillset_exposes_loading_and_verified_publication_search_only():
    from harmonia_agent.agents import build_agent_team
    from harmonia_agent.noni_skills import NONI_SKILL_ROOT
    specialist = build_agent_team().find_sub_agent("noni_copywriter")
    assert NONI_SKILL_NAME in specialist.instruction
    assert all((NONI_SKILL_ROOT / path).read_text().strip() for path in NONI_SKILL_REFERENCES)
    assert not any(tool.tool_name in {"load_skill", "load_skill_resource"} for tool in specialist.tools)



def test_noni_research_tools_have_real_read_only_contracts():
    contracts = noni_skills.validate_noni_tool_contracts()

    assert set(contracts) == {"search_verified_publications"}
    assert all(contract.permission == "read" for contract in contracts.values())
    assert all(contract.external_effect is False for contract in contracts.values())
    assert contracts["search_verified_publications"].data_scope == "workspace"


def test_verified_publication_search_returns_only_live_canonical_provenance(monkeypatch):
    monkeypatch.setattr(noni_skills.web_client, "search_verified_publications", lambda **_kwargs: {
        "publications": [{
            "publicationId": "pub-1", "platform": "x", "text": "Verified operating proof.",
            "canonicalUrl": "https://x.com/harmonia/status/123", "publishedAt": "2026-08-20T10:00:00Z",
            "receiptId": "receipt-1", "verificationId": "verification-1",
        }],
    })

    result = noni_skills.search_verified_publications("brief-1", "operating proof", 5)

    assert result["status"] == "success"
    assert result["data"]["briefId"] == "brief-1"
    assert result["data"]["publications"][0]["verificationId"] == "verification-1"
    assert result["evidence"][0]["reference"] == "https://x.com/harmonia/status/123"
    assert result["evidence"][0]["provenance"] == "live"


def test_noni_agent_receives_exactly_the_dedicated_writing_skillset():
    noni = build_agent_team().find_sub_agent("noni_copywriter")
    assert [tool.tool_name for tool in noni.tools] == ["search_verified_publications"]
    assert "PRELOADED noni skill" in noni.instruction



def _trace(*resources: str) -> list[dict]:
    calls = [{"sequence": 1, "name": "load_skill", "args": {"skill_name": NONI_SKILL_NAME}}]
    calls.extend({
        "sequence": index + 2,
        "name": "load_skill_resource",
        "args": {"skill_name": NONI_SKILL_NAME, "file_path": resource},
    } for index, resource in enumerate(resources))
    return calls


def _research_call(name: str, *, sequence: int, brief_id: str, evidence_id: str) -> dict:
    if name == "gateway_search":
        return {
            "sequence": sequence,
            "name": name,
            "args": {"request": f"For brief {brief_id}, research agent approval workflow terminology."},
            "response": {
                "briefId": brief_id,
                "query": "agent approval workflow terminology",
                "sources": [{
                    "evidenceId": evidence_id,
                    "title": "Google Search Grounding",
                    "url": "https://adk.dev/grounding/google_search_grounding/",
                    "supportedText": "Ground responses with Google Search.",
                }],
            },
        }
    args = {"brief_id": brief_id, "query": "agent approval workflow", "limit": 3}
    return {
        "sequence": sequence,
        "name": name,
        "args": args,
        "response": {
            "status": "success", "data": {}, "error": None,
            "evidence": [{
                "evidenceId": evidence_id, "source": name,
                "provenance": "live", "reference": "https://example.com/source",
            }],
        },
    }


def test_noni_trace_requires_one_skill_and_at_least_one_approved_reference():
    assert validate_noni_skill_trace(_trace("references/hooks-and-introductions.md")) == {}

    with pytest.raises(ValueError, match="exactly once first"):
        validate_noni_skill_trace([])
    with pytest.raises(ValueError, match="at least one writing reference"):
        validate_noni_skill_trace(_trace())
    with pytest.raises(ValueError, match="unapproved resource"):
        validate_noni_skill_trace(_trace("references/unknown.md"))


def test_noni_trace_accepts_the_short_form_video_script_method():
    assert validate_noni_skill_trace(
        _trace("references/short-form-video-scripts.md")
    ) == {}


def _grounding_metadata() -> dict:
    return {"provider": "agentcore_gateway", "responseSha256": "a" * 64, "sources": [{
        "evidenceId": "ev-2222222222222222", "title": "Google Search Grounding",
        "url": "https://adk.dev/grounding/google_search_grounding/", "supportedText": "Ground responses with Google Search.",
    }]}


def test_noni_trace_allows_native_grounded_search_after_writing_reference():
    calls = _trace("references/persuasion.md")
    calls.append(_research_call(
        "search_verified_publications", sequence=3, brief_id="brief-1",
        evidence_id="ev-1111111111111111",
    ))
    calls.append(_research_call(
        "gateway_search", sequence=4, brief_id="brief-1",
        evidence_id="ev-2222222222222222",
    ))

    evidence = validate_noni_skill_trace(
        calls, brief_id="brief-1", brief_text="Agent approval workflow terminology",
        grounding_metadata=_grounding_metadata(),
    )

    assert evidence == {
        "ev-1111111111111111": ("https://example.com/source",),
        "ev-2222222222222222": (
            "Ground responses with Google Search.",
            "Google Search Grounding",
            "https://adk.dev/grounding/google_search_grounding/",
        ),
    }


def test_noni_trace_rejects_cross_brief_research_and_unprovenanced_results():
    wrong_brief = _trace("references/persuasion.md")
    wrong_brief.append(_research_call(
        "gateway_search", sequence=3, brief_id="brief-other",
        evidence_id="ev-2222222222222222",
    ))
    with pytest.raises(ValueError, match="exact brief"):
        validate_noni_skill_trace(
            wrong_brief, brief_id="brief-1", brief_text="Agent approval workflow terminology",
            grounding_metadata=_grounding_metadata(),
        )

    missing_evidence = _trace("references/persuasion.md")
    call = _research_call(
        "gateway_search", sequence=3, brief_id="brief-1",
        evidence_id="ev-2222222222222222",
    )
    call["response"]["sources"] = []
    missing_evidence.append(call)
    with pytest.raises(ValueError, match="provenance"):
        validate_noni_skill_trace(
            missing_evidence, brief_id="brief-1", brief_text="Agent approval workflow terminology",
            grounding_metadata=_grounding_metadata(),
        )


def test_noni_trace_rejects_research_outside_the_active_brief():
    calls = _trace("references/persuasion.md")
    call = _research_call(
        "gateway_search", sequence=3, brief_id="brief-1",
        evidence_id="ev-2222222222222222",
    )
    call["args"]["request"] = "Research celebrity fashion gossip."
    call["response"]["query"] = "celebrity fashion gossip"
    calls.append(call)

    with pytest.raises(ValueError, match="outside the active brief"):
        validate_noni_skill_trace(
            calls, brief_id="brief-1", brief_text="Agent approval workflow terminology",
            grounding_metadata=_grounding_metadata(),
        )


def test_noni_trace_rejects_native_search_source_missing_from_grounding_metadata():
    calls = _trace("references/persuasion.md")
    call = _research_call(
        "gateway_search", sequence=3, brief_id="brief-1",
        evidence_id="ev-2222222222222222",
    )
    call["response"]["sources"][0]["url"] = "https://example.com/invented"
    calls.append(call)

    with pytest.raises(ValueError, match="provider response"):
        validate_noni_skill_trace(
            calls, brief_id="brief-1", brief_text="Agent approval workflow terminology",
            grounding_metadata=_grounding_metadata(),
        )


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
