"""Deterministic quality and authority checks for agent evaluation."""

from harmonia_agent.agent_models import AnalysisResult, Draft, DraftSet
from harmonia_agent.evaluation_contracts import (
    TrajectoryStep,
    evaluate_action_plan,
    evaluate_analysis,
    evaluate_drafts,
    evaluate_editor,
    validate_specialist_trajectory,
)


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
        requested="sophia_analyst",
        steps=[TrajectoryStep(kind="delegate", name="ryan_strategist")],
    )

    assert result.passed is False
    assert result.failures[0].code == "wrong_specialist"


def test_analysis_rejects_out_of_bounds_time_and_ungrounded_quote():
    result = evaluate_analysis(
        analysis=_analysis(endSec=61, quote="words absent from the source"),
        transcript="[2s] We cut nine days to forty hours.",
        duration_sec=60,
    )

    assert {failure.code for failure in result.failures} == {
        "moment_out_of_bounds", "quote_not_in_transcript",
    }


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
