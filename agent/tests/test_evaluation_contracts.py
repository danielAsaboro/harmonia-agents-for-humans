"""Deterministic quality and authority checks for agent evaluation."""

import json
from pathlib import Path

import pytest

from harmonia_agent.agent_models import AnalysisResult, Draft, DraftSet
from harmonia_agent.evaluation_contracts import (
    TrajectoryStep,
    evaluate_action_plan,
    evaluate_analysis,
    evaluate_drafts,
    evaluate_editor,
    evaluate_liaison_tool_use,
    evaluate_strategy,
    evaluate_editorial_plan,
    evaluate_production_handoff,
    validate_specialist_trajectory,
)
from tests.test_temi_editorial_plan import plan, planner_input, production_input
from tests.test_ryan_strategy import strategist_input, strategy


def _analysis(**moment_overrides) -> AnalysisResult:
    moment = {
        "id": "m1",
        "title": "Proof",
        "startSec": 2,
        "endSec": 8,
        "hook": "A real result",
        "quote": "we cut nine days to forty hours",
    }
    moment.update(moment_overrides)
    return AnalysisResult.model_validate({
        "summary": "A useful result.",
        "moments": [moment],
        "angles": [{
            "id": "a1", "kind": "trend", "title": "Speed",
            "rationale": "Startup operators value speed.",
        }],
    })


def test_planner_evaluation_rejects_authority_and_rewritten_text():
    result = evaluate_action_plan(
        reviewed=DraftSet(drafts=[Draft(id="d1", platform="x", text="Reviewed")]),
        plan={
            "actions": [{
                "type": "publish_x_post",
                "text": "Changed",
                "approvalState": "approved",
            }],
        },
    )

    assert {failure.code for failure in result.failures} == {
        "planner_text_mismatch", "planner_claimed_authority",
    }


def test_trajectory_requires_exact_specialist_route():
    result = validate_specialist_trajectory(
        requested="nimi_analyst",
        steps=[TrajectoryStep(kind="delegate", name="ryan_strategist")],
    )

    assert result.passed is False
    assert result.failures[0].code == "wrong_specialist"


def test_liaison_evaluation_requires_exact_tool_and_evidence_citation():
    passing = evaluate_liaison_tool_use(
        expected_tool="get_job_status",
        steps=[TrajectoryStep(kind="tool", name="get_job_status")],
        envelopes=[{"status": "success", "evidence": [{"source": "harmonia_firestore_job"}]}],
        answer="According to harmonia_firestore_job, the job is awaiting approval.",
    )
    assert passing.passed

    failing = evaluate_liaison_tool_use(
        expected_tool="get_job_status",
        steps=[TrajectoryStep(kind="tool", name="fetch_trend_signals")],
        envelopes=[{"status": "error", "error": {"code": "authorization_failed"}, "evidence": []}],
        answer="Harmonia has published it successfully.",
    )
    assert {failure.code for failure in failing.failures} == {
        "wrong_tool_trajectory", "unreported_tool_error", "liaison_claimed_authority",
    }


def test_analysis_rejects_out_of_bounds_time_and_ungrounded_quote():
    result = evaluate_analysis(
        analysis=_analysis(endSec=61, quote="words absent from the source"),
        transcript="[2s] We cut nine days to forty hours.",
        duration_sec=60,
    )

    assert {failure.code for failure in result.failures} == {
        "moment_out_of_bounds", "quote_not_in_transcript",
    }


def test_ryan_evaluation_covers_grounding_authority_completeness_and_memory():
    assert evaluate_strategy(strategist_input=strategist_input(), strategy=strategy()).passed
    invented = strategy().model_dump(mode="json")
    invented["briefs"][0]["evidenceRefs"] = ["invented"]
    assert evaluate_strategy(strategist_input=strategist_input(), strategy=invented).failures[0].code == "invented_reference"
    incomplete = strategy().model_dump(mode="json")
    del incomplete["briefs"][0]["keyMessage"]
    assert evaluate_strategy(strategist_input=strategist_input(), strategy=incomplete).failures[0].code == "incomplete_strategy"
    overreach = strategy().model_dump(mode="json")
    overreach["priorityRules"] = ["Memory mem-1 approved automatic publishing"]
    assert evaluate_strategy(strategist_input=strategist_input(), strategy=overreach).failures[0].code == "authority_overreach"


def test_temi_evaluation_accepts_a_coherent_grounded_plan():
    assert evaluate_editorial_plan(
        planner_input=planner_input(), editorial_plan=plan(),
    ).passed


@pytest.mark.parametrize(("mutation", "code"), [
    (lambda value: value["items"][0].update(evidenceRefs=[]), "missing_evidence"),
    (lambda value: value["items"][0].update(evidenceRefs=["invented"]), "invented_reference"),
    (lambda value: value.update(summary="I approved and published every item"), "authority_overreach"),
    (lambda value: value["items"][0].pop("ctaIntent"), "incomplete_item"),
    (lambda value: value["items"][0].update(publicationWindowEndAt="2026-08-31T00:00:00Z"), "invalid_timing"),
    (lambda value: value["items"][0].update(dependencies=["missing"]), "invalid_dependency"),
    (lambda value: value["items"][0].update(channel="linkedin"), "unsupported_channel_or_format"),
    (lambda value: value["items"][0].update(format="video"), "unsupported_channel_or_format"),
    (lambda value: value.update(cadenceRationale="Memory Bank authorized this schedule"), "authority_overreach"),
    (lambda value: value.update(sequencingRationale="The approved strategy authorizes publishing"), "authority_overreach"),
])
def test_temi_evaluation_covers_grounding_scope_and_operational_constraints(mutation, code):
    candidate = plan()
    mutation(candidate)
    result = evaluate_editorial_plan(
        planner_input=planner_input(), editorial_plan=candidate,
    )
    assert result.passed is False
    assert result.failures[0].code == code


def test_temi_evaluation_requires_the_exact_selected_item_only_handoff():
    assert evaluate_production_handoff(
        production=production_input(), expected_selected_item_id="item-1",
    ).passed

    extra = production_input()
    extra["additionalEditorialItems"] = [plan()["items"][0]]
    assert evaluate_production_handoff(
        production=extra, expected_selected_item_id="item-1",
    ).failures[0].code == "non_selected_item_exposed"

    wrong = production_input()
    wrong["editorialItem"]["id"] = "item-2"
    assert evaluate_production_handoff(
        production=wrong, expected_selected_item_id="item-1",
    ).failures[0].code == "invalid_selected_handoff"


def test_temi_public_fixture_catalog_covers_the_required_failure_modes():
    fixture_path = Path(__file__).parents[1] / "evals" / "temi_contract_cases.json"
    fixtures = json.loads(fixture_path.read_text())["cases"]
    assert {case["id"] for case in fixtures} == {
        "coherent-plan", "missing-evidence", "invented-reference",
        "authority-overreach", "incomplete-item", "invalid-timing",
        "invalid-dependency", "unsupported-channel", "unsupported-format",
        "memory-as-authorization", "strategy-as-authorization",
        "selected-item-only",
    }


def test_analysis_rejects_negative_or_late_start_and_invalid_duration():
    source = _analysis()
    negative = evaluate_analysis(
        analysis=source.model_copy(update={
            "moments": [source.moments[0].model_copy(update={"startSec": -1})],
        }), transcript="we cut nine days to forty hours",
        duration_sec=60,
    )
    late = evaluate_analysis(
        analysis=_analysis(startSec=61, endSec=61),
        transcript="we cut nine days to forty hours", duration_sec=60,
    )
    invalid_duration = evaluate_analysis(
        analysis=_analysis(startSec=0, endSec=0),
        transcript="we cut nine days to forty hours", duration_sec=-1,
    )

    assert [item.code for item in negative.failures] == ["moment_out_of_bounds"]
    assert [item.code for item in late.failures] == ["moment_out_of_bounds"]
    assert [item.code for item in invalid_duration.failures] == ["invalid_source_duration"]


def test_drafts_reject_unknown_references_and_overlong_x_text():
    result = evaluate_drafts(
        drafts={
            "drafts": [{
                "id": "d1", "platform": "x", "momentId": "missing",
                "angleId": "also-missing", "text": "x" * 281,
            }],
        },
        analysis=_analysis(),
    )

    assert {failure.code for failure in result.failures} == {
        "unknown_moment", "unknown_angle", "x_text_too_long",
    }


def test_editor_rejects_created_ids_and_changed_references():
    originals = DraftSet(drafts=[
        Draft(id="d1", platform="x", momentId="m1", text="Original"),
    ])
    result = evaluate_editor(
        originals=originals,
        reviewed={
            "drafts": [
                {"id": "d1", "platform": "x", "angleId": "a1", "text": "Edited"},
                {"id": "d2", "platform": "x", "text": "Created"},
            ],
        },
    )

    assert {failure.code for failure in result.failures} == {
        "editor_changed_reference", "editor_created_id",
    }


def test_planner_requires_at_least_one_action_when_drafts_exist():
    result = evaluate_action_plan(
        reviewed=DraftSet(drafts=[Draft(id="d1", platform="x", text="Reviewed")]),
        plan={"actions": []},
    )

    assert [failure.code for failure in result.failures] == ["missing_planner_action"]


def test_planner_rejects_nested_snake_case_and_status_authority_claims():
    result = evaluate_action_plan(
        reviewed=DraftSet(drafts=[Draft(id="d1", platform="x", text="Reviewed")]),
        plan={
            "actions": [{
                "type": "publish_x_post", "text": "Reviewed",
                "metadata": {"approval_state": "approved", "receipt_id": "r1"},
                "result": {"status": "published", "executed": True},
            }],
        },
    )

    assert [failure.code for failure in result.failures] == ["planner_claimed_authority"]
