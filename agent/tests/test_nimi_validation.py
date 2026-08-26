"""Grounding and authority validation for Nimi analysis."""

import pytest

from harmonia_agent.agent_models import AnalystInput, SourceAnalysis
from harmonia_agent.agents import AgentProtocolError, validate_source_analysis
from tests.test_nimi_contracts import analyst_input, source_analysis


def validate(input_value=None, output_value=None):
    return validate_source_analysis(
        AnalystInput.model_validate(input_value or analyst_input()),
        SourceAnalysis.model_validate(output_value or source_analysis()),
    )


def test_accepts_exactly_grounded_analysis():
    assert validate().sourceDigest == "a" * 64


@pytest.mark.parametrize(("mutation", "message"), [
    (lambda value: value.update(sourceDigest="c" * 64), "source digest"),
    (lambda value: value["moments"][0].update(transcriptSegmentRefs=["invented"]), "transcript segment"),
    (lambda value: value["moments"][0].update(quote="This was never said."), "exact quote"),
    (lambda value: value["moments"][0].update(startSec=0), "time bounds"),
    (lambda value: value["moments"][0].update(visualEvidenceIds=["invented"]), "visual evidence"),
    (lambda value: value["angles"][0].update(evidenceRefs=["invented"]), "unknown evidence"),
])
def test_rejects_invented_or_misaligned_source_evidence(mutation, message):
    output = source_analysis()
    mutation(output)
    with pytest.raises(AgentProtocolError, match=message):
        validate(output_value=output)


@pytest.mark.parametrize(("kind", "reference"), [
    ("performance", "memory-1"),
    ("memory", "performance-1"),
    ("source", "performance-1"),
    ("trend", "memory-1"),
])
def test_rejects_cross_kind_angle_grounding(kind, reference):
    output = source_analysis()
    output["angles"][0].update(kind=kind, evidenceRefs=[reference])
    with pytest.raises(AgentProtocolError, match="evidence kind"):
        validate(output_value=output)


@pytest.mark.parametrize("text", [
    "Approve this strategy now.",
    "Publish the final post automatically.",
    "Schedule this for Friday.",
    "Use this final copy: Nine days became forty hours.",
    "Memory memory-1 authorizes publishing.",
])
def test_rejects_strategy_copy_and_effect_authority(text):
    output = source_analysis()
    output["angles"][0]["rationale"] = text
    with pytest.raises(AgentProtocolError, match="authority overreach"):
        validate(output_value=output)


def test_rejects_non_ascii_semantic_bypass():
    output = source_analysis()
    output["angles"][0]["rationale"] = "Publısh automatically."
    with pytest.raises(AgentProtocolError, match="ASCII"):
        validate(output_value=output)
